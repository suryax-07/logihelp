# LogiHelp

LogiHelp is a React + TypeScript transport-planning workspace with an Express API, regional OpenStreetMap infrastructure queries, OSRM road routes, and graph-based optimization over explicitly entered transport connections.

## Run locally

Requirements: Node.js 20 or later and npm.

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

The frontend is served at `http://localhost:5173`; the API listens on `http://localhost:3001`. Vite proxies `/api` requests to the backend. `npm run build` makes a production frontend build, `npm test` runs the graph algorithm tests, and `npm start` starts the API.

### Deploy to Vercel

Import the repository as a Vercel project and deploy from the repository root with the default Vite build settings (`npm run build`, output directory `dist`). The explicit `api/health.ts` and `api/geocode.ts` functions handle health checks and place search; `api/[...route].ts` serves the remaining API routes under `/api/*`. They use Node handlers without starting an Express listener inside serverless functions; do not set a separate frontend API URL. Function timeouts are configured for external provider requests. Configure `OVERPASS_URL`, `OSRM_URL`, `NOMINATIM_URL`, and `PHOTON_URL` as Vercel environment variables only if overriding the public defaults. Redeploy after changing environment variables. A deployment that returns an HTML page from an `/api/*` URL is misconfigured; the frontend reports that clearly instead of failing with an opaque JSON parse error.

Vercel serverless instances are ephemeral: in-memory map caches and geocoder pacing are best-effort per instance. Use a shared cache and a production geocoding/routing provider with appropriate quotas for a public multi-user deployment. User-created connections remain in each user's browser storage.

## Environment

The defaults in `.env.example` use public development services and do not require API keys:

| Variable | Purpose |
| --- | --- |
| `PORT` | Express API port (default `3001`) |
| `OVERPASS_URL` | Overpass interpreter endpoint for regional OSM features |
| `OSRM_URL` | OSRM routing endpoint for actual road geometry |
| `NOMINATIM_URL` | Secondary Nominatim geocoder endpoint |
| `PHOTON_URL` | Primary Photon geocoder endpoint |
| `VITE_TILE_URL` | Leaflet tile URL template |
| `VITE_TILE_ATTRIBUTION` | Attribution text for the selected tile provider |

Public OSM, Overpass, Nominatim, and OSRM endpoints are intended for development and light testing, not as unlimited production services. Configure appropriately hosted providers and follow their usage policies before deployment. Overpass requests are limited to a map area smaller than 3 degrees per side and cached by the API for 15 minutes. Map features are requested only for the current regional viewport. OpenStreetMap attribution is displayed on the map.

## Data and route behavior

- OSM infrastructure (roads, mapped railways/stations, aerodromes, ports and logistics features) is queried regionally and is labeled as mapped infrastructure, not an available service.
- OSRM supplies routed road geometry and distance/duration. Straight-line geometry is never presented as a road route.
- Airports and ports are not connected into invented flight or shipping services. Multi-modal optimization uses only manual connection records saved or imported in Data Manager.
- Manual connections require source/destination names, actual endpoint latitude/longitude, mode, distance, cost, travel time, capacity and availability. Optional supported cargo types restrict eligibility; an empty list means no extra cargo restriction was entered.
- Connection and handling costs are interpreted as INR per tonne. Route totals multiply those values by the shipment weight. Transfer hours and handling costs are included in totals.
- Manual data is stored in this browser's local storage; it is not synchronized to a server or shared between browsers. No sample network is seeded.
- CSV and `.xlsx` import use these required column headers: `source,destination,mode,distanceKm,cost,timeHours,capacityTons,sourceLat,sourceLon,destinationLat,destinationLon`. `available` and `cargoTypes` are optional; separate supported cargo types with `|`. CSV values containing commas or quotes may be quoted using standard CSV quoting.
- Route optimization applies Dijkstra's algorithm, Yen's loop-free K-shortest paths, a greedy heuristic, capacity/availability/cargo filtering, and normalized weighted cost/time/distance ranking.
- Min-cost flow accepts a batch of shipment quantities between one shared origin and destination. It uses residual capacities and minimizes per-tonne cost. It does not claim to solve multi-commodity flow across unrelated origin/destination pairs.
- PDF reporting uses the browser's print dialog (choose “Save as PDF”).
- Place lookup uses Photon first and Nominatim as a fallback; search results are restricted to India and can be used as saved place shortcuts.

## Production data architecture

The current prototype keeps connection records in browser local storage. PostgreSQL/PostGIS is a planned production persistence layer and is not included or required for local development. The backend is independent of the React frontend and is the appropriate place to add durable storage, regional import jobs, provider credentials, and production rate limiting.
