import "dotenv/config";
import cors from "cors";
import express from "express";
import type { InfrastructureFeature, InfrastructureResponse, TransportMode } from "../shared/types";
import { optimizeFlow, optimizeRoutes } from "./algorithms";

export const app = express();
const port = Number(process.env.PORT ?? 3001);
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const cache = new Map<string, { expiresAt: number; body: InfrastructureResponse }>();
const cacheTtlMs = 15 * 60 * 1000;
let nextGeocodeAt = 0;

app.get("/api/health", (_req, res) => res.json({ status: "ok", service: "logihelp-api" }));

app.get("/api/geocode", async (req, res) => {
  const query = String(req.query.q ?? "").trim();
  if (query.length < 2 || query.length > 120) {
    res.status(400).json({ error: "Search text must be between 2 and 120 characters." });
    return;
  }
  try {
    const base = (process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org").replace(/\/$/, "");
    const requestAt = Math.max(Date.now(), nextGeocodeAt);
    nextGeocodeAt = requestAt + 1000;
    await new Promise((resolve) => setTimeout(resolve, requestAt - Date.now()));
    let nominatimStatus = "unavailable";
    try {
      const nominatimResponse = await fetch(`${base}/search?format=jsonv2&limit=5&countrycodes=in&q=${encodeURIComponent(query)}`, {
        headers: { "User-Agent": "LogiHelp/1.0 (transport planning prototype)" },
        signal: AbortSignal.timeout(8000),
      });
      nominatimStatus = String(nominatimResponse.status);
      if (nominatimResponse.ok) {
        const results = await nominatimResponse.json() as Array<{ place_id: number; display_name: string; lat: string; lon: string; type: string }>;
        if (results.length) {
          res.json(results.map((result) => ({
            id: result.place_id,
            label: result.display_name,
            lat: Number(result.lat),
            lon: Number(result.lon),
            type: result.type,
          })));
          return;
        }
      }
    } catch { /* Continue to the secondary geocoder. */ }

    const photonUrl = new URL(process.env.PHOTON_URL ?? "https://photon.komoot.io/api/");
    photonUrl.searchParams.set("q", query);
    photonUrl.searchParams.set("limit", "5");
    photonUrl.searchParams.set("lang", "en");
    photonUrl.searchParams.set("bbox", "68.1,6.5,97.4,35.5");
    const photonResponse = await fetch(photonUrl, { signal: AbortSignal.timeout(10000) });
    if (!photonResponse.ok) throw new Error(`Location providers returned ${nominatimStatus} and ${photonResponse.status}.`);
    const photonData = await photonResponse.json() as {
      features?: Array<{
        geometry?: { coordinates?: [number, number] };
        properties?: Record<string, string | number | undefined>;
      }>;
    };
    const results = (photonData.features ?? []).flatMap((feature, index) => {
      const coordinates = feature.geometry?.coordinates;
      const properties = feature.properties;
      if (!coordinates || !properties) return [];
      const label = [properties.name, properties.city, properties.state, properties.country]
        .filter((part, partIndex, parts) => part && parts.indexOf(part) === partIndex)
        .join(", ");
      if (!label || String(properties.country ?? "").toLowerCase() !== "india") return [];
      return [{ id: `photon-${String(properties.osm_id ?? index)}`, label, lon: coordinates[0], lat: coordinates[1], type: String(properties.osm_value ?? "place") }];
    });
    res.json(results);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Geocoding service unavailable." });
  }
});

app.get("/api/infrastructure", async (req, res) => {
  const values = ["south", "west", "north", "east"].map((key) => Number(req.query[key]));
  if (values.some((value) => !Number.isFinite(value))) {
    res.status(400).json({ error: "A valid south, west, north and east bounding box is required." });
    return;
  }
  const [south, west, north, east] = values;
  if (south >= north || west >= east || north - south > 3 || east - west > 3 ||
    south < -90 || north > 90 || west < -180 || east > 180) {
    res.status(400).json({ error: "Map area is invalid or too large. Zoom in to a region under 3 degrees." });
    return;
  }
  const modes = String(req.query.modes ?? "road,rail,air,sea,logistics")
    .split(",").filter((mode): mode is TransportMode | "logistics" =>
      ["road", "rail", "air", "sea", "logistics"].includes(mode));
  const cacheKey = `${values.join(",")}|${[...modes].sort().join(",")}`;
  const existing = cache.get(cacheKey);
  if (existing && existing.expiresAt > Date.now()) {
    res.setHeader("X-Data-Cache", "HIT");
    res.json(existing.body);
    return;
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
    const endpoint = process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "User-Agent": "LogiHelp/1.0" },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Overpass returned ${response.status}. Try a smaller map area later.`);
    const data = await response.json() as { elements?: Array<Record<string, unknown>> };
    const features: InfrastructureFeature[] = (data.elements ?? []).flatMap((element) => {
      const tags = element.tags as Record<string, string> | undefined;
      if (!tags) return [];
      const elementType = String(element.type);
      const id = `${elementType}/${String(element.id)}`;
      const geometry = element.geometry as Array<{ lat: number; lon: number }> | undefined;
      const center = element.center as { lat: number; lon: number } | undefined;
      let geo: InfrastructureFeature["geometry"];
      if (geometry && geometry.length) {
        const coordinates = geometry.map((point) => [point.lon, point.lat]);
        const closed = geometry.length > 3 &&
          geometry[0].lat === geometry[geometry.length - 1].lat &&
          geometry[0].lon === geometry[geometry.length - 1].lon;
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
    cache.set(cacheKey, { expiresAt: Date.now() + cacheTtlMs, body });
    res.setHeader("X-Data-Cache", "MISS");
    res.json(body);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Infrastructure provider unavailable." });
  }
});

app.get("/api/road-route", async (req, res) => {
  const coordinates = [req.query.fromLat, req.query.fromLon, req.query.toLat, req.query.toLon].map(Number);
  if (coordinates.some((value) => !Number.isFinite(value))) {
    res.status(400).json({ error: "Valid origin and destination coordinates are required." });
    return;
  }
  const [fromLat, fromLon, toLat, toLon] = coordinates;
  if ([fromLat, toLat].some((lat) => lat < -90 || lat > 90) ||
    [fromLon, toLon].some((lon) => lon < -180 || lon > 180)) {
    res.status(400).json({ error: "Coordinates are out of range." });
    return;
  }
  try {
    const base = (process.env.OSRM_URL ?? "https://router.project-osrm.org").replace(/\/$/, "");
    const response = await fetch(`${base}/route/v1/driving/${fromLon},${fromLat};${toLon},${toLat}?overview=full&geometries=geojson&steps=false`, {
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`OSRM returned ${response.status}.`);
    const data = await response.json() as { code: string; routes?: Array<{ distance: number; duration: number; geometry: unknown }> };
    if (data.code !== "Ok" || !data.routes?.length) throw new Error("No road route was found for these locations.");
    res.json({ ...data.routes[0], source: "OSRM / OpenStreetMap" });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Road routing service unavailable." });
  }
});

app.post("/api/optimize", (req, res) => {
  try {
    const { connections, request } = req.body as { connections: unknown; request: unknown };
    if (!Array.isArray(connections) || !request || typeof request !== "object") {
      res.status(400).json({ error: "Provide a connections array and optimization request." });
      return;
    }
    const result = optimizeRoutes(connections as Parameters<typeof optimizeRoutes>[0], request as Parameters<typeof optimizeRoutes>[1]);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Optimization failed." });
  }
});

app.post("/api/min-cost-flow", (req, res) => {
  try {
    const { connections, shipments, modes } = req.body as {
      connections: unknown;
      shipments: unknown;
      modes: unknown;
    };
    if (!Array.isArray(connections) || !Array.isArray(shipments) || !Array.isArray(modes)) {
      res.status(400).json({ error: "Provide connections, a shipment batch and allowed modes." });
      return;
    }
    res.json(optimizeFlow(
      connections as Parameters<typeof optimizeFlow>[0],
      shipments as Parameters<typeof optimizeFlow>[1],
      modes as Parameters<typeof optimizeFlow>[2],
    ));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Min-cost flow calculation failed." });
  }
});

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`LogiHelp API listening on http://localhost:${port}`);
  });
}
