import type { IncomingMessage, ServerResponse } from "node:http";
import type { InfrastructureFeature, InfrastructureResponse, TransportMode } from "../shared/types";
import { optimizeFlow, optimizeRoutes } from "./algorithms";

type RequestWithBody = IncomingMessage & { body?: unknown };
const infrastructureCache = new Map<string, { expiresAt: number; body: InfrastructureResponse }>();
const cacheTtlMs = 15 * 60 * 1000;

function respond(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: RequestWithBody): Promise<unknown> {
  if (req.body !== undefined) {
    if (typeof req.body === "string") {
      try {
        return JSON.parse(req.body) as unknown;
      } catch {
        throw new Error("Request body must contain valid JSON.");
      }
    }
    return req.body;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > 2 * 1024 * 1024) throw new Error("Request body exceeds the 2 MB limit.");
    chunks.push(data);
  }
  if (!size) throw new Error("Request body must contain valid JSON.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("Request body must contain valid JSON.");
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseModes(value: string | null): Array<TransportMode | "logistics"> {
  return (value ?? "road,rail,air,sea,logistics")
    .split(",")
    .filter((mode): mode is TransportMode | "logistics" =>
      ["road", "rail", "air", "sea", "logistics"].includes(mode));
}

async function geocode(query: string) {
  if (query.length < 2 || query.length > 120) {
    return { status: 400, body: { error: "Search text must be between 2 and 120 characters." } };
  }

  const photonUrl = new URL(process.env.PHOTON_URL ?? "https://photon.komoot.io/api/");
  photonUrl.searchParams.set("q", query);
  photonUrl.searchParams.set("limit", "5");
  photonUrl.searchParams.set("lang", "en");
  photonUrl.searchParams.set("bbox", "68.1,6.5,97.4,35.5");

  let photonError = "unavailable";
  try {
    const response = await fetch(photonUrl, { signal: AbortSignal.timeout(8000) });
    photonError = String(response.status);
    if (response.ok) {
      const data = await response.json() as {
        features?: Array<{
          geometry?: { coordinates?: [number, number] };
          properties?: Record<string, string | number | undefined>;
        }>;
      };
      const places = (data.features ?? []).flatMap((feature, index) => {
        const coordinates = feature.geometry?.coordinates;
        const properties = feature.properties;
        if (!coordinates || !properties) return [];
        const country = String(properties.country ?? "").toLowerCase();
        if (country && country !== "india") return [];
        const label = [properties.name, properties.city, properties.state, properties.country]
          .filter((part, partIndex, parts) => part && parts.indexOf(part) === partIndex)
          .join(", ");
        if (!label || !coordinates.every(Number.isFinite) ||
          coordinates[0] < 68.1 || coordinates[0] > 97.4 ||
          coordinates[1] < 6.5 || coordinates[1] > 35.5) return [];
        return [{
          id: `photon-${String(properties.osm_id ?? index)}`,
          label,
          lon: coordinates[0],
          lat: coordinates[1],
          type: String(properties.osm_value ?? "place"),
        }];
      });
      if (places.length) return { status: 200, body: places };
    }
  } catch (error) {
    photonError = error instanceof Error ? error.message : "unavailable";
  }

  try {
    const base = (process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org").replace(/\/$/, "");
    const response = await fetch(`${base}/search?format=jsonv2&limit=5&countrycodes=in&q=${encodeURIComponent(query)}`, {
      headers: { "User-Agent": "LogiHelp/1.0 (transport planning prototype)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      return { status: 502, body: { error: `Location providers are unavailable (Photon: ${photonError}; Nominatim: ${response.status}).` } };
    }
    const results = await response.json() as Array<{ place_id: number; display_name: string; lat: string; lon: string; type: string }>;
    const places = results.map((result) => ({
      id: result.place_id,
      label: result.display_name,
      lat: Number(result.lat),
      lon: Number(result.lon),
      type: result.type,
    })).filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lon));
    return { status: 200, body: places };
  } catch (error) {
    return {
      status: 502,
      body: { error: `Location search failed. Photon: ${photonError}; Nominatim: ${error instanceof Error ? error.message : "unavailable"}.` },
    };
  }
}

async function infrastructure(url: URL) {
  const values = ["south", "west", "north", "east"].map((key) => Number(url.searchParams.get(key)));
  if (values.some((value) => !Number.isFinite(value))) {
    return { status: 400, body: { error: "A valid south, west, north and east bounding box is required." } };
  }
  const [south, west, north, east] = values;
  if (south >= north || west >= east || north - south > 3 || east - west > 3 ||
    south < -90 || north > 90 || west < -180 || east > 180) {
    return { status: 400, body: { error: "Map area is invalid or too large. Zoom in to a region under 3 degrees." } };
  }
  const modes = parseModes(url.searchParams.get("modes"));
  const cacheKey = `${values.join(",")}|${[...modes].sort().join(",")}`;
  const cached = infrastructureCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { status: 200, body: cached.body, cache: "HIT" };
  }

  const bounds = `${south},${west},${north},${east}`;
  const queries: string[] = [];
  if (modes.includes("road")) queries.push(`way["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"](${bounds});`);
  if (modes.includes("rail")) queries.push(`(way["railway"="rail"](${bounds});nwr["railway"~"^(station|halt|tram_stop)$"](${bounds}););`);
  if (modes.includes("air")) queries.push(`nwr["aeroway"~"^(aerodrome|terminal)$"](${bounds});`);
  if (modes.includes("sea")) queries.push(`nwr["harbour"~"^(yes|port)$"](${bounds});nwr["seamark:type"~"^(harbour|port)$"](${bounds});nwr["industrial"="port"](${bounds});`);
  if (modes.includes("logistics")) queries.push(`nwr["man_made"="warehouse"](${bounds});nwr["industrial"](${bounds});nwr["landuse"="industrial"](${bounds});`);
  const query = `[out:json][timeout:25];(${queries.join("")});out meta center geom qt;`;

  try {
    const response = await fetch(process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "User-Agent": "LogiHelp/1.0" },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) {
      return { status: 502, body: { error: `Overpass returned ${response.status}. Try a smaller map area later.` } };
    }
    const data = await response.json() as { elements?: Array<Record<string, unknown>> };
    const features: InfrastructureFeature[] = (data.elements ?? []).flatMap((element) => {
      const tags = element.tags as Record<string, string> | undefined;
      if (!tags) return [];
      const id = `${String(element.type)}/${String(element.id)}`;
      const geometry = element.geometry as Array<{ lat: number; lon: number }> | undefined;
      const center = element.center as { lat: number; lon: number } | undefined;
      let geo: InfrastructureFeature["geometry"];
      if (geometry?.length) {
        const coordinates = geometry.map((point) => [point.lon, point.lat]);
        const last = geometry[geometry.length - 1];
        const closed = geometry.length > 3 &&
          geometry[0].lat === last.lat && geometry[0].lon === last.lon;
        if (closed && tags.area !== "no" && (tags.aeroway || tags.landuse || tags.man_made || tags.industrial)) {
          geo = { type: "Polygon", coordinates: [coordinates] };
        } else {
          geo = { type: "LineString", coordinates };
        }
      } else if (center) {
        geo = { type: "Point", coordinates: [center.lon, center.lat] };
      } else if (typeof element.lat === "number" && typeof element.lon === "number") {
        geo = { type: "Point", coordinates: [element.lon, element.lat] };
      } else return [];
      return [{
        type: "Feature",
        id,
        geometry: geo,
        properties: {
          name: tags.name ?? tags.ref ?? "Unnamed mapped feature",
          category: tags.highway ? `Road · ${tags.highway}` : tags.railway ? `Rail · ${tags.railway}` :
            tags.aeroway ? `Air · ${tags.aeroway}` : tags.harbour ? `Sea · ${tags.harbour}` :
              tags.man_made ?? tags.landuse ?? "Infrastructure",
          ref: tags.ref,
          source: "OpenStreetMap",
          lastEditedAt: typeof element.timestamp === "string" ? element.timestamp : undefined,
          retrievedAt: new Date().toISOString(),
        },
      }];
    });
    const body: InfrastructureResponse = { type: "FeatureCollection", features, source: "OpenStreetMap", retrievedAt: new Date().toISOString() };
    infrastructureCache.set(cacheKey, { expiresAt: Date.now() + cacheTtlMs, body });
    return { status: 200, body, cache: "MISS" };
  } catch (error) {
    return { status: 502, body: { error: error instanceof Error ? error.message : "Infrastructure provider unavailable." } };
  }
}

async function roadRoute(url: URL) {
  const coordinates = ["fromLat", "fromLon", "toLat", "toLon"].map((key) => Number(url.searchParams.get(key)));
  if (coordinates.some((value) => !Number.isFinite(value))) {
    return { status: 400, body: { error: "Valid origin and destination coordinates are required." } };
  }
  const [fromLat, fromLon, toLat, toLon] = coordinates;
  if ([fromLat, toLat].some((lat) => lat < -90 || lat > 90) ||
    [fromLon, toLon].some((lon) => lon < -180 || lon > 180)) {
    return { status: 400, body: { error: "Coordinates are out of range." } };
  }
  try {
    const base = (process.env.OSRM_URL ?? "https://router.project-osrm.org").replace(/\/$/, "");
    const response = await fetch(`${base}/route/v1/driving/${fromLon},${fromLat};${toLon},${toLat}?overview=full&geometries=geojson&steps=false`, {
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) return { status: 502, body: { error: `OSRM returned ${response.status}.` } };
    const data = await response.json() as { code: string; routes?: Array<{ distance: number; duration: number; geometry: unknown }> };
    if (data.code !== "Ok" || !data.routes?.length) {
      return { status: 404, body: { error: "No road route was found for these locations." } };
    }
    return { status: 200, body: { ...data.routes[0], source: "OSRM / OpenStreetMap" } };
  } catch (error) {
    return { status: 502, body: { error: error instanceof Error ? error.message : "Road routing service unavailable." } };
  }
}

function routePath(pathname: string) {
  const path = pathname.startsWith("/api/") ? pathname.slice(4) : pathname;
  return path === "/api" ? "/" : path;
}

export async function handleApiRequest(req: RequestWithBody, res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  } catch {
    respond(res, 400, { error: "Invalid request URL." });
    return;
  }
  const path = routePath(url.pathname);
  const method = req.method ?? "GET";

  try {
    if (path === "/health" && method === "GET") {
      respond(res, 200, { status: "ok", service: "logihelp-api" });
      return;
    }
    if (path === "/geocode" && method === "GET") {
      const result = await geocode(url.searchParams.get("q")?.trim() ?? "");
      respond(res, result.status, result.body);
      return;
    }
    if (path === "/infrastructure" && method === "GET") {
      const result = await infrastructure(url);
      if (result.cache) res.setHeader("X-Data-Cache", result.cache);
      respond(res, result.status, result.body);
      return;
    }
    if (path === "/road-route" && method === "GET") {
      const result = await roadRoute(url);
      respond(res, result.status, result.body);
      return;
    }
    if ((path === "/optimize" || path === "/min-cost-flow") && method === "POST") {
      const body = asObject(await readJsonBody(req));
      if (!body) {
        respond(res, 400, { error: "Request body must be a JSON object." });
        return;
      }
      if (path === "/optimize") {
        if (!Array.isArray(body.connections) || !asObject(body.request)) {
          respond(res, 400, { error: "Provide a connections array and optimization request." });
          return;
        }
        respond(res, 200, optimizeRoutes(
          body.connections as Parameters<typeof optimizeRoutes>[0],
          body.request as Parameters<typeof optimizeRoutes>[1],
        ));
        return;
      }
      if (!Array.isArray(body.connections) || !Array.isArray(body.shipments) || !Array.isArray(body.modes)) {
        respond(res, 400, { error: "Provide connections, a shipment batch and allowed modes." });
        return;
      }
      respond(res, 200, optimizeFlow(
        body.connections as Parameters<typeof optimizeFlow>[0],
        body.shipments as Parameters<typeof optimizeFlow>[1],
        body.modes as Parameters<typeof optimizeFlow>[2],
      ));
      return;
    }
    respond(res, 404, { error: "API endpoint not found." });
  } catch (error) {
    console.error(`LogiHelp API ${method} ${path} failed:`, error);
    const message = error instanceof Error ? error.message : "Unexpected API error.";
    const status = message.includes("Request body") ? 400 : 500;
    respond(res, status, { error: message });
  }
}
