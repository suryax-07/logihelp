export async function geocode(query: string) {
  if (query.length < 2 || query.length > 120) {
    return { status: 400, body: { error: "Search text must be between 2 and 120 characters." } };
  }

  let photonError = "unavailable";
  try {
    const photonUrl = new URL(process.env.PHOTON_URL ?? "https://photon.komoot.io/api/");
    photonUrl.searchParams.set("q", query);
    photonUrl.searchParams.set("limit", "5");
    photonUrl.searchParams.set("lang", "en");
    photonUrl.searchParams.set("bbox", "68.1,6.5,97.4,35.5");

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
