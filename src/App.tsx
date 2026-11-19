import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, ArrowDownUp, ArrowRight, BarChart3, Boxes, CalendarClock, Check,
  CircleHelp, Clock3, Database, Download, Factory, FileText, Gauge, Layers3, LocateFixed,
  Map as MapIcon, MapPin, Menu, Navigation, Plus, Search, Settings2, Ship, SlidersHorizontal,
  Star, TrainFront, Truck, X, Plane,
} from "lucide-react";
import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  CircleMarker, GeoJSON, MapContainer, Polyline, TileLayer, useMap, useMapEvents,
} from "react-leaflet";
import type { LatLngBounds } from "leaflet";
import type {
  CargoType, Connection, InfrastructureFeature, InfrastructureResponse, OptimizationMetric, RouteRequest,
  RouteResult, TransportMode,
} from "../shared/types";

type Page = "Overview" | "Infrastructure map" | "Route planner" | "Data manager" | "Optimization workspace" | "Route comparison" | "Reports & analytics" | "Settings";
type Location = { id: number | string; label: string; lat: number; lon: number; type: string };
type RouteGeometry = { coordinates: [number, number][]; distance: number; duration: number; source: string };
type PlannerPreferences = {
  cargoWeight: number;
  cargoType: CargoType;
  metric: OptimizationMetric;
  modes: TransportMode[];
};

const navigation: { name: Page; icon: typeof MapIcon }[] = [
  { name: "Overview", icon: Gauge },
  { name: "Infrastructure map", icon: MapIcon },
  { name: "Route planner", icon: Navigation },
  { name: "Data manager", icon: Database },
  { name: "Optimization workspace", icon: Activity },
  { name: "Route comparison", icon: ArrowDownUp },
  { name: "Reports & analytics", icon: BarChart3 },
];
const modeLabels: Record<TransportMode, string> = { road: "Road", rail: "Rail", air: "Air", sea: "Sea" };
const modeColors: Record<TransportMode, string> = { road: "#3d78c5", rail: "#df9a36", air: "#8b68c1", sea: "#28a0a0" };
const cityMapCenter: [number, number] = [22.9, 79.2];
const storageKey = "logihelp-connections-v1";
const plannerPreferencesKey = "logihelp-planner-preferences-v1";
const defaultPlannerPreferences: PlannerPreferences = {
  cargoWeight: 10,
  cargoType: "general",
  metric: "cost",
  modes: ["road", "rail", "air", "sea"],
};
const tileUrl = import.meta.env.VITE_TILE_URL || "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const tileAttribution = import.meta.env.VITE_TILE_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.text();
  let data: (T & { error?: string }) | undefined;
  try {
    data = body ? JSON.parse(body) as T & { error?: string } : undefined;
  } catch {
    const endpoint = new URL(url, window.location.origin).pathname;
    if (body.trimStart().startsWith("<")) {
      throw new Error(response.status === 404
        ? "The LogiHelp API is not deployed for this Vercel project. Redeploy from the repository root so the /api serverless function is included."
        : "The API returned a web page instead of JSON. Check the Vercel API deployment and server logs.");
    }
    const detail = body.trim().slice(0, 180);
    throw new Error(`The API endpoint ${endpoint} returned a non-JSON response (${response.status})${detail ? `: ${detail}` : "."}`);
  }
  if (!data) throw new Error(`The API returned an empty response (${response.status}). Please try again.`);
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
  return data;
}

function saveRecentRoute(source: string, destination: string, mode: string) {
  let recent: Array<Record<string, string>> = [];
  try {
    const stored = JSON.parse(localStorage.getItem("logihelp-recent-routes") ?? "[]") as unknown;
    if (Array.isArray(stored)) recent = stored as Array<Record<string, string>>;
  } catch {
    recent = [];
  }
  localStorage.setItem("logihelp-recent-routes", JSON.stringify([
    { source, destination, mode, updatedAt: new Date().toISOString(), status: "Calculated" },
    ...recent,
  ].slice(0, 20)));
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' && quoted && text[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(field); field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field); field = "";
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("CSV contains an unclosed quoted field.");
  row.push(field);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

function useConnections() {
  const [connections, setConnections] = useState<Connection[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? "[]") as Connection[];
    } catch {
      return [];
    }
  });
  useEffect(() => localStorage.setItem(storageKey, JSON.stringify(connections)), [connections]);
  return [connections, setConnections] as const;
}

function readSavedLocations(key: string): Location[] {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "[]") as Location[];
    return Array.isArray(saved) ? saved.filter((location) =>
      typeof location.label === "string" && Number.isFinite(location.lat) && Number.isFinite(location.lon),
    ) : [];
  } catch {
    return [];
  }
}

function readPlannerPreferences(): PlannerPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(plannerPreferencesKey) ?? "{}") as Partial<PlannerPreferences>;
    const cargoTypes: CargoType[] = ["general", "perishable", "hazardous", "oversized", "bulk"];
    const metrics: OptimizationMetric[] = ["cost", "distance", "time"];
    const validModes = Array.isArray(saved.modes)
      ? saved.modes.filter((mode): mode is TransportMode => ["road", "rail", "air", "sea"].includes(mode))
      : defaultPlannerPreferences.modes;
    const cargoWeight = saved.cargoWeight;
    return {
      cargoWeight: typeof cargoWeight === "number" && Number.isFinite(cargoWeight) && cargoWeight > 0
        ? cargoWeight
        : defaultPlannerPreferences.cargoWeight,
      cargoType: cargoTypes.includes(saved.cargoType as CargoType) ? saved.cargoType! : defaultPlannerPreferences.cargoType,
      metric: metrics.includes(saved.metric as OptimizationMetric) ? saved.metric! : defaultPlannerPreferences.metric,
      modes: validModes.length ? validModes : defaultPlannerPreferences.modes,
    };
  } catch {
    return defaultPlannerPreferences;
  }
}

function MapBoundsListener({ onBounds }: { onBounds: (bounds: LatLngBounds) => void }) {
  const map = useMap();
  useMapEvents({
    moveend: () => onBounds(map.getBounds()),
    zoomend: () => onBounds(map.getBounds()),
  });
  useEffect(() => onBounds(map.getBounds()), [map, onBounds]);
  return null;
}

function Recenter({ position, source, destination }: { position?: [number, number]; source?: Location | null; destination?: Location | null }) {
  const map = useMap();
  useEffect(() => {
    if (source && destination) {
      map.fitBounds([[source.lat, source.lon], [destination.lat, destination.lon]], { padding: [36, 36], maxZoom: 9, animate: true });
    } else {
      const target = position ?? (destination ? [destination.lat, destination.lon] as [number, number] :
        source ? [source.lat, source.lon] as [number, number] : undefined);
      if (target) map.flyTo(target, Math.max(map.getZoom(), 10), { duration: 0.6 });
    }
  }, [map, position, source, destination]);
  return null;
}

function MapPanel({
  height = "100%",
  expanded = false,
  route,
  source,
  destination,
  connections = [],
  activeLayers,
  onLayerToggle,
  onFeatures,
  showControls = true,
}: {
  height?: string;
  expanded?: boolean;
  route?: RouteGeometry | null;
  source?: Location | null;
  destination?: Location | null;
  connections?: Connection[];
  activeLayers?: Record<string, boolean>;
  onLayerToggle?: (layer: "roads" | "rail" | "facilities") => void;
  onFeatures?: (features: InfrastructureFeature[]) => void;
  showControls?: boolean;
}) {
  const [features, setFeatures] = useState<InfrastructureFeature[]>([]);
  const [mapError, setMapError] = useState("");
  const [mapStatus, setMapStatus] = useState("Zoom in to load mapped infrastructure");
  const [recentBounds, setRecentBounds] = useState("");
  const [mapTarget, setMapTarget] = useState<[number, number] | undefined>();
  const [selectedDetails, setSelectedDetails] = useState<Record<string, string | number | undefined> | null>(null);
  const [localLayers, setLocalLayers] = useState({ roads: true, rail: true, facilities: true });
  const layers = activeLayers ?? localLayers;
  const updateBounds = useCallback((bounds: LatLngBounds) => {
    const south = bounds.getSouth();
    const west = bounds.getWest();
    const north = bounds.getNorth();
    const east = bounds.getEast();
    if (north - south > 2.8 || east - west > 2.8 || bounds.getNorthEast().lat > 90) {
      setMapStatus("Zoom in to a regional view to load OSM features");
      return;
    }
    const key = [south, west, north, east].map((value) => value.toFixed(2)).join(",");
    setRecentBounds((previous) => previous === key ? previous : key);
  }, []);

  useEffect(() => {
    if (!recentBounds) return;
    const [south, west, north, east] = recentBounds.split(",");
    const controller = new AbortController();
    setMapStatus("Loading OpenStreetMap features…");
    setMapError("");
    requestJson<InfrastructureResponse>(`/api/infrastructure?south=${south}&west=${west}&north=${north}&east=${east}`, { signal: controller.signal })
      .then((response) => {
        setFeatures(response.features);
        onFeatures?.(response.features);
        setMapStatus(`${response.features.length.toLocaleString()} mapped features · OpenStreetMap`);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setMapError(error instanceof Error ? error.message : "Map data is unavailable.");
        setMapStatus("OSM data unavailable");
      });
    return () => controller.abort();
  }, [recentBounds, onFeatures]);

  const visibleFeatures = features.filter((feature) => {
    const category = String(feature.properties.category ?? "");
    if (category.startsWith("Road")) return layers.roads;
    if (category.startsWith("Rail")) return layers.rail;
    return layers.facilities;
  });
  const onFeatureClick = (feature: InfrastructureFeature) => {
    const coords = feature.geometry.coordinates;
    const point = feature.geometry.type === "Point" ? coords as [number, number] : null;
    if (point) setMapTarget([point[1], point[0]]);
    setSelectedDetails(feature.properties);
  };
  const visibleManualConnections = connections.filter((edge) =>
    edge.sourceLat !== undefined && edge.sourceLon !== undefined &&
    edge.destinationLat !== undefined && edge.destinationLon !== undefined &&
    (edge.mode === "road" ? layers.roads : edge.mode === "rail" ? layers.rail : layers.facilities),
  );

  return (
    <div className={`map-canvas ${expanded ? "map-canvas-expanded" : ""}`} style={{ height }}>
      <MapContainer center={cityMapCenter} zoom={5} scrollWheelZoom className="leaflet-map">
        <TileLayer
          attribution={tileAttribution}
          url={tileUrl}
        />
        <MapBoundsListener onBounds={updateBounds} />
        <Recenter position={mapTarget} source={source} destination={destination} />
        {visibleFeatures.map((feature) => {
          const category = String(feature.properties.category ?? "");
          const color = category.startsWith("Road") ? modeColors.road :
            category.startsWith("Rail") ? modeColors.rail :
              category.startsWith("Air") ? modeColors.air : modeColors.sea;
          if (feature.geometry.type === "Point") {
            const [lon, lat] = feature.geometry.coordinates as [number, number];
            return (
              <CircleMarker key={feature.id} center={[lat, lon]} radius={5} pathOptions={{ color, fillColor: color, fillOpacity: 0.8 }} eventHandlers={{ click: () => onFeatureClick(feature) }} />
            );
          }
          return (
            <GeoJSON
              key={feature.id}
              data={feature as never}
              style={{ color, weight: category.startsWith("Road") ? 2 : 2.5, opacity: 0.74 }}
              eventHandlers={{ click: () => onFeatureClick(feature) }}
            />
          );
        })}
        {visibleManualConnections.map((edge) => (
          <Polyline key={`manual-${edge.id}`} positions={[[edge.sourceLat!, edge.sourceLon!], [edge.destinationLat!, edge.destinationLon!]]}
            pathOptions={{ color: modeColors[edge.mode], weight: 3, dashArray: "5 5", opacity: 0.9 }}
            eventHandlers={{ click: () => setSelectedDetails({ name: `${edge.source} → ${edge.destination}`, category: `Manual ${modeLabels[edge.mode]} connection`, source: "User-entered manual data", updatedAt: edge.updatedAt, cost: edge.cost }) }} />
        ))}
        {route && <Polyline positions={route.coordinates.map(([lon, lat]) => [lat, lon])} pathOptions={{ color: "#23845c", weight: 5, opacity: 0.9 }} />}
        {source && <CircleMarker center={[source.lat, source.lon]} radius={8} pathOptions={{ color: "#fff", weight: 3, fillColor: "#23845c", fillOpacity: 1 }} />}
        {destination && <CircleMarker center={[destination.lat, destination.lon]} radius={8} pathOptions={{ color: "#fff", weight: 3, fillColor: "#c75d55", fillOpacity: 1 }} />}
      </MapContainer>
      {showControls && (
        <>
          <div className="map-status"><span className="status-dot" />{mapStatus}</div>
          <div className="map-zoom-controls">
            {(["roads", "rail", "facilities"] as const).map((layer) => (
              <button key={layer} className={`layer-pill ${layers[layer] ? "active" : ""}`} onClick={() => onLayerToggle ? onLayerToggle(layer) : setLocalLayers((old) => ({ ...old, [layer]: !old[layer] }))}>
                <span className="legend-dot" style={{ backgroundColor: layer === "roads" ? modeColors.road : layer === "rail" ? modeColors.rail : modeColors.air }} />
                {layer === "roads" ? "Roads" : layer === "rail" ? "Rail" : "Facilities"}
              </button>
            ))}
            <button className="map-icon-button" title="Return to India view" onClick={() => { setMapTarget(cityMapCenter); }}>
              <LocateFixed size={16} />
            </button>
          </div>
          {mapError && <div className="map-error"><CircleHelp size={15} />{mapError}</div>}
          {selectedDetails && <div className="feature-detail"><button aria-label="Close feature details" onClick={() => setSelectedDetails(null)}><X size={14} /></button><strong>{String(selectedDetails.name ?? "Mapped infrastructure")}</strong><span>{String(selectedDetails.category ?? "OpenStreetMap feature")}</span><small>{String(selectedDetails.source ?? "OpenStreetMap")} · {selectedDetails.lastEditedAt ? `Last OSM edit ${new Date(String(selectedDetails.lastEditedAt)).toLocaleDateString()}` : selectedDetails.retrievedAt ? `Retrieved ${new Date(String(selectedDetails.retrievedAt)).toLocaleDateString()}` : "Source update date unavailable"}</small></div>}
        </>
      )}
    </div>
  );
}

function StatCard({ title, value, note, icon: Icon, tone }: { title: string; value: string; note: string; icon: typeof Truck; tone: string }) {
  return (
    <div className="stat-card">
      <div className={`stat-icon ${tone}`}><Icon size={18} strokeWidth={1.8} /></div>
      <div className="stat-copy"><span>{title}</span><strong>{value}</strong><small>{note}</small></div>
      <ArrowRight className="stat-arrow" size={16} />
    </div>
  );
}

function Header({ page, onMenu }: { page: Page; onMenu: () => void }) {
  const now = new Date();
  return (
    <header className="topbar">
      <button className="mobile-menu" onClick={onMenu} aria-label="Open navigation"><Menu size={20} /></button>
      <div className="breadcrumb"><span>LogiHelp</span><span className="crumb-slash">/</span><strong>{page}</strong></div>
      <div className="topbar-right">
        <span className="workspace-label"><span className="online-dot" />Operations workspace</span>
        <span className="topbar-divider" />
        <span className="topbar-date"><CalendarClock size={15} />{now.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</span>
        <button className="avatar" title="Operations user">OP</button>
      </div>
    </header>
  );
}

function Sidebar({ page, setPage, open, onClose }: { page: Page; setPage: (page: Page) => void; open: boolean; onClose: () => void }) {
  return (
    <>
      {open && <button aria-label="Close menu backdrop" className="sidebar-backdrop" onClick={onClose} />}
      <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
        <div className="brand"><div className="brand-mark"><Boxes size={21} /></div><div><b>LogiHelp</b><span>NETWORK OPERATIONS</span></div></div>
        <div className="sidebar-section-label">WORKSPACE</div>
        <nav className="main-nav">
          {navigation.map(({ name, icon: Icon }) => (
            <button key={name} onClick={() => { setPage(name); onClose(); }} className={`nav-item ${page === name ? "selected" : ""}`}>
              <Icon size={17} strokeWidth={1.8} /><span>{name}</span>
              {name === "Route planner" && <span className="nav-shortcut">⌘1</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="source-card"><div className="source-card-top"><span className="source-badge"><Layers3 size={14} /></span><span>DATA SOURCES</span><span className="source-live-dot" /></div><strong>OpenStreetMap</strong><small>Regional map queries · on demand</small></div>
          <button onClick={() => { setPage("Settings"); onClose(); }} className={`nav-item settings-item ${page === "Settings" ? "selected" : ""}`}><Settings2 size={17} /><span>Settings</span></button>
          <div className="sidebar-footnote">LogiHelp <span>v1.0.0</span><br />Transport planning platform</div>
        </div>
      </aside>
    </>
  );
}

function PageTitle({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="page-title-row">
      <div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1><p>{description}</p></div>
      {action && <div className="title-action">{action}</div>}
    </div>
  );
}

function Dashboard({ connections, setPage }: { connections: Connection[]; setPage: (page: Page) => void }) {
  const [recentRoutes] = useState(() => {
    try { return JSON.parse(localStorage.getItem("logihelp-recent-routes") ?? "[]") as Array<{ source: string; destination: string; mode: string; updatedAt: string; status: string }>; }
    catch { return []; }
  });
  const [featureCounts, setFeatureCounts] = useState<{ air: number | null; rail: number | null }>({ air: null, rail: null });
  const updateFeatureCounts = useCallback((features: InfrastructureFeature[]) => {
    setFeatureCounts({
      air: features.filter((feature) => String(feature.properties.category ?? "").startsWith("Air")).length,
      rail: features.filter((feature) => String(feature.properties.category ?? "").startsWith("Rail")).length,
    });
  }, []);
  const chartData = (["road", "rail", "air", "sea"] as const).map((mode) => ({
    mode: modeLabels[mode], connections: connections.filter((item) => item.mode === mode).length,
  }));
  const today = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }).toUpperCase();
  return (
    <>
      <PageTitle eyebrow={today} title="Operations overview" description="A clear view of your transport network and route activity." action={<button className="button button-primary" onClick={() => setPage("Route planner")}><Plus size={16} />Plan a route</button>} />
      <div className="stats-grid">
        <StatCard title="Saved connections" value={connections.length.toLocaleString()} note="User-entered records" icon={ArrowDownUp} tone="blue" />
        <StatCard title="Air facilities loaded" value={featureCounts.air === null ? "—" : featureCounts.air.toLocaleString()} note="Current map viewport · OSM" icon={Plane} tone="violet" />
        <StatCard title="Rail facilities loaded" value={featureCounts.rail === null ? "—" : featureCounts.rail.toLocaleString()} note="Current map viewport · OSM" icon={TrainFront} tone="amber" />
        <StatCard title="Modes available" value="4" note="Road · Rail · Air · Sea" icon={Boxes} tone="teal" />
      </div>
      <div className="dashboard-grid">
        <section className="panel map-panel">
          <div className="panel-heading"><div><h2>Network overview</h2><p>OpenStreetMap base layer · India</p></div><button className="text-button" onClick={() => setPage("Infrastructure map")}>Explore map <ArrowRight size={14} /></button></div>
          <MapPanel height="350px" connections={connections} onFeatures={updateFeatureCounts} />
        </section>
        <section className="panel chart-panel">
          <div className="panel-heading"><div><h2>Connections by mode</h2><p>Saved manual network records</p></div><span className="tag tag-neutral">CURRENT</span></div>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 3, left: -20, bottom: 0 }}>
                <CartesianGrid stroke="#edf0f3" vertical={false} />
                <XAxis dataKey="mode" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "#8290a1" }} />
                <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "#8290a1" }} />
                <Tooltip />
                <Bar dataKey="connections" fill="#4a80b8" radius={[3, 3, 0, 0]} maxBarSize={38} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="chart-footnote"><span><i className="small-status-dot" />{connections.length} saved connections in this workspace</span><span>Browser data · by mode</span></div>
        </section>
      </div>
      <section className="panel recent-panel">
        <div className="panel-heading"><div><h2>Recent route calculations</h2><p>Your latest planning activity</p></div><button className="text-button" onClick={() => setPage("Route comparison")}>View all <ArrowRight size={14} /></button></div>
        {recentRoutes.length ? (
          <div className="table-scroll"><table><thead><tr><th>ORIGIN / DESTINATION</th><th>MODE</th><th>CALCULATED</th><th>STATUS</th></tr></thead><tbody>
            {recentRoutes.slice(0, 4).map((route, index) => <tr key={index}><td><span className="route-pair">{route.source}<ArrowRight size={13} />{route.destination}</span></td><td>{route.mode}</td><td>{new Date(route.updatedAt).toLocaleString()}</td><td><span className="tag tag-green">{route.status}</span></td></tr>)}
          </tbody></table></div>
        ) : <div className="empty-table"><div className="empty-icon"><Navigation size={19} /></div><div><strong>No route calculations yet</strong><p>Plan a route to see calculations appear here.</p></div><button className="button button-secondary" onClick={() => setPage("Route planner")}>Open route planner <ArrowRight size={14} /></button></div>}
      </section>
    </>
  );
}

function InfrastructurePage({ setPage, connections }: { setPage: (page: Page) => void; connections: Connection[] }) {
  const [layers, setLayers] = useState({ roads: true, rail: true, facilities: true });
  const toggle = (name: keyof typeof layers) => setLayers((value) => ({ ...value, [name]: !value[name] }));
  return (
    <>
      <PageTitle eyebrow="GEOSPATIAL NETWORK" title="Infrastructure map" description="Explore mapped transport infrastructure by region. Features are loaded from OpenStreetMap as you zoom." action={<button className="button button-primary" onClick={() => setPage("Route planner")}><Navigation size={15} />Route planner</button>} />
      <div className="map-toolbar panel">
        <div className="map-toolbar-left"><span className="toolbar-label">LAYERS</span>{(["roads", "rail", "facilities"] as const).map((layer) => (
          <button className={`filter-toggle ${layers[layer] ? "enabled" : ""}`} key={layer} onClick={() => toggle(layer)}><span className={`layer-check ${layers[layer] ? "checked" : ""}`}>{layers[layer] && <Check size={11} />}</span>{layer === "roads" ? "Road network" : layer === "rail" ? "Railways & stations" : "Air, sea & logistics"}</button>
        ))}</div>
        <span className="map-toolbar-note"><MapPin size={14} />Zoom into a region to query OSM</span>
      </div>
      <section className="panel full-map-panel"><MapPanel height="calc(100vh - 300px)" expanded connections={connections} activeLayers={layers} onLayerToggle={toggle} />
        <div className="map-attribution-note">Map data © OpenStreetMap contributors · Features shown as mapped, not necessarily operational</div>
      </section>
    </>
  );
}

function RoutePlanner({ connections, setPage, onCalculated }: { connections: Connection[]; setPage: (page: Page) => void; onCalculated: (routes: RouteResult[]) => void }) {
  const [plannerDefaults] = useState(readPlannerPreferences);
  const [sourceText, setSourceText] = useState("");
  const [destinationText, setDestinationText] = useState("");
  const [source, setSource] = useState<Location | null>(null);
  const [destination, setDestination] = useState<Location | null>(null);
  const [searching, setSearching] = useState<"source" | "destination" | null>(null);
  const [suggestions, setSuggestions] = useState<Location[]>([]);
  const [suggestionFor, setSuggestionFor] = useState<"source" | "destination" | null>(null);
  const [autocompleteTarget, setAutocompleteTarget] = useState<"source" | "destination" | null>(null);
  const [placeTarget, setPlaceTarget] = useState<"source" | "destination">("source");
  const [recentPlaces, setRecentPlaces] = useState<Location[]>(() => readSavedLocations("logihelp-recent-places"));
  const [favoritePlaces, setFavoritePlaces] = useState<Location[]>(() => readSavedLocations("logihelp-favorite-places"));
  const [cargoWeight, setCargoWeight] = useState(plannerDefaults.cargoWeight);
  const [cargoType, setCargoType] = useState<RouteRequest["cargoType"]>(plannerDefaults.cargoType);
  const [maxBudget, setMaxBudget] = useState("");
  const [maxHours, setMaxHours] = useState("");
  const [metric, setMetric] = useState<OptimizationMetric>(plannerDefaults.metric);
  const [modes, setModes] = useState<TransportMode[]>(plannerDefaults.modes);
  const [priorities, setPriorities] = useState({ cost: 50, time: 30, distance: 20 });
  const [route, setRoute] = useState<RouteGeometry | null>(null);
  const [results, setResults] = useState<RouteResult[]>([]);
  const [routeMessage, setRouteMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    localStorage.setItem("logihelp-recent-places", JSON.stringify(recentPlaces));
  }, [recentPlaces]);
  useEffect(() => {
    localStorage.setItem("logihelp-favorite-places", JSON.stringify(favoritePlaces));
  }, [favoritePlaces]);
  useEffect(() => {
    if (!autocompleteTarget) return;
    const query = autocompleteTarget === "source" ? sourceText.trim() : destinationText.trim();
    if (query.length < 3) {
      setSuggestions([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(autocompleteTarget);
      setSuggestionFor(autocompleteTarget);
      requestJson<Location[]>(`/api/geocode?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((found) => setSuggestions(found))
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setSuggestions([]);
          setRouteMessage(error instanceof Error ? error.message : "Location search failed.");
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(null);
        });
    }, 450);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [autocompleteTarget, sourceText, destinationText]);

  const searchLocation = async (target: "source" | "destination") => {
    const query = target === "source" ? sourceText : destinationText;
    setAutocompleteTarget(null);
    setSearching(target);
    setSuggestionFor(target);
    setSuggestions([]);
    setRouteMessage("");
    try {
      const found = await requestJson<Location[]>(`/api/geocode?q=${encodeURIComponent(query)}`);
      setSuggestions(found);
      if (!found.length) setRouteMessage("No matching locations were returned. Try a more specific place name.");
    } catch (error) {
      setRouteMessage(error instanceof Error ? error.message : "Location search failed.");
    } finally { setSearching(null); }
  };
  const chooseLocation = (target: "source" | "destination", location: Location) => {
    if (target === "source") { setSource(location); setSourceText(location.label.split(",")[0]); }
    else { setDestination(location); setDestinationText(location.label.split(",")[0]); }
    setPlaceTarget(target === "source" ? "destination" : "source");
    setRecentPlaces((previous) => [location, ...previous.filter((place) => place.id !== location.id)].slice(0, 6));
    setSuggestions([]);
    setSuggestionFor(null);
    setAutocompleteTarget(null);
  };
  const toggleFavorite = (location: Location) => {
    setFavoritePlaces((previous) => previous.some((place) => place.id === location.id)
      ? previous.filter((place) => place.id !== location.id)
      : [location, ...previous].slice(0, 8));
  };
  const toggleMode = (mode: TransportMode) => setModes((current) => current.includes(mode) ? current.filter((value) => value !== mode) : [...current, mode]);
  const calculateRoad = async () => {
    if (!source || !destination) { setRouteMessage("Search and select both locations before calculating a road route."); return; }
    setBusy(true); setRouteMessage(""); setResults([]);
    try {
      const data = await requestJson<{ distance: number; duration: number; geometry: { coordinates: [number, number][] }; source: string }>(
        `/api/road-route?fromLat=${source.lat}&fromLon=${source.lon}&toLat=${destination.lat}&toLon=${destination.lon}`,
      );
      setRoute({ coordinates: data.geometry.coordinates, distance: data.distance, duration: data.duration, source: data.source });
      setRouteMessage("Road route calculated from OSRM road geometry.");
      saveRecentRoute(source.label.split(",")[0], destination.label.split(",")[0], "Road");
    } catch (error) { setRouteMessage(error instanceof Error ? error.message : "Could not calculate a road route."); }
    finally { setBusy(false); }
  };
  const calculateGraph = async () => {
    if (!sourceText.trim() || !destinationText.trim()) { setRouteMessage("Enter source and destination connection names."); return; }
    if (!modes.length) { setRouteMessage("Choose at least one transportation mode."); return; }
    const request: RouteRequest = {
      source: sourceText.trim(), destination: destinationText.trim(), cargoWeight,
      cargoType,
      maxBudget: maxBudget ? Number(maxBudget) : undefined, maxHours: maxHours ? Number(maxHours) : undefined,
      modes, metric, priorities, alternatives: 4,
    };
    setBusy(true); setRouteMessage("");
    try {
      const data = await requestJson<{ routes: RouteResult[]; explanation: string }>("/api/optimize", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connections, request }),
      });
      setResults(data.routes);
      onCalculated(data.routes);
      setRouteMessage(data.explanation);
      if (data.routes.length) {
        saveRecentRoute(request.source, request.destination, data.routes[0].modes.map((mode) => modeLabels[mode]).join(" / "));
      }
      if (!data.routes.length) setRoute(null);
      else setPage("Optimization workspace");
    } catch (error) { setRouteMessage(error instanceof Error ? error.message : "Optimization failed."); }
    finally { setBusy(false); }
  };
  const swap = () => {
    setSourceText(destinationText); setDestinationText(sourceText);
    setSource(destination); setDestination(source);
  };

  return (
    <>
      <PageTitle eyebrow="MULTI-MODAL PLANNING" title="Route planner" description="Set shipment constraints and compare feasible transport options." />
      <div className="planner-layout">
        <section className="panel planner-form-panel">
          <div className="panel-heading"><div><h2>Shipment details</h2><p>Enter your origin, destination and requirements</p></div><span className="step-count">01 / 02</span></div>
          <div className="location-fields">
            <div className="location-field">
              <label htmlFor="source">ORIGIN</label><div className="location-input-wrap"><span className="location-mark origin-mark" /><input id="source" placeholder="Search a city or address" value={sourceText} onChange={(event) => { setSourceText(event.target.value); setSource(null); setAutocompleteTarget("source"); setSuggestionFor("source"); }} onFocus={() => setPlaceTarget("source")} onKeyDown={(event) => event.key === "Enter" && void searchLocation("source")} /><button className="search-field-button" onClick={() => void searchLocation("source")} aria-label="Search origin"><Search size={16} /></button></div>
              {searching === "source" && <div className="inline-hint">Searching OpenStreetMap…</div>}
              {!!suggestions.length && suggestionFor === "source" && searching === null && <div className="suggestion-list">{suggestions.map((item) => <div className="suggestion-row" key={item.id}><button className="suggestion-place" onClick={() => chooseLocation("source", item)}><MapPin size={14} /><span>{item.label}</span></button><button className={`favorite-toggle ${favoritePlaces.some((place) => place.id === item.id) ? "is-favorite" : ""}`} onClick={() => toggleFavorite(item)} aria-label={favoritePlaces.some((place) => place.id === item.id) ? "Remove saved place" : "Save place"}><Star size={14} fill={favoritePlaces.some((place) => place.id === item.id) ? "currentColor" : "none"} /></button></div>)}</div>}
            </div>
            <button className="swap-locations" onClick={swap} aria-label="Swap origin and destination"><ArrowDownUp size={15} /></button>
            <div className="location-field">
              <label htmlFor="destination">DESTINATION</label><div className="location-input-wrap"><span className="location-mark destination-mark" /><input id="destination" placeholder="Search a city or address" value={destinationText} onChange={(event) => { setDestinationText(event.target.value); setDestination(null); setAutocompleteTarget("destination"); setSuggestionFor("destination"); }} onFocus={() => setPlaceTarget("destination")} onKeyDown={(event) => event.key === "Enter" && void searchLocation("destination")} /><button className="search-field-button" onClick={() => void searchLocation("destination")} aria-label="Search destination"><Search size={16} /></button></div>
              {searching === "destination" && <div className="inline-hint">Searching OpenStreetMap…</div>}
              {!!suggestions.length && suggestionFor === "destination" && searching === null && <div className="suggestion-list">{suggestions.map((item) => <div className="suggestion-row" key={item.id}><button className="suggestion-place" onClick={() => chooseLocation("destination", item)}><MapPin size={14} /><span>{item.label}</span></button><button className={`favorite-toggle ${favoritePlaces.some((place) => place.id === item.id) ? "is-favorite" : ""}`} onClick={() => toggleFavorite(item)} aria-label={favoritePlaces.some((place) => place.id === item.id) ? "Remove saved place" : "Save place"}><Star size={14} fill={favoritePlaces.some((place) => place.id === item.id) ? "currentColor" : "none"} /></button></div>)}</div>}
            </div>
          </div>
          {(recentPlaces.length > 0 || favoritePlaces.length > 0) && <div className="saved-places">
            <div className="saved-places-heading"><span><Star size={13} />Saved places</span><div><button className={placeTarget === "source" ? "active" : ""} onClick={() => setPlaceTarget("source")}>Use as origin</button><button className={placeTarget === "destination" ? "active" : ""} onClick={() => setPlaceTarget("destination")}>Use as destination</button></div></div>
            <div className="saved-place-chips">{[...favoritePlaces, ...recentPlaces.filter((place) => !favoritePlaces.some((saved) => saved.id === place.id))].slice(0, 8).map((place) => <button key={`${place.id}-${place.label}`} onClick={() => chooseLocation(placeTarget, place)} title={`${place.label} · click to use as ${placeTarget}`}><MapPin size={12} />{place.label.split(",")[0]}{favoritePlaces.some((saved) => saved.id === place.id) && <Star size={11} fill="currentColor" />}</button>)}</div>
          </div>}
          <div className="form-divider" />
          <div className="form-two-col">
            <label className="form-field"><span>CARGO WEIGHT <small>TONNES</small></span><input type="number" min="0.1" step="0.1" value={cargoWeight} onChange={(event) => setCargoWeight(Number(event.target.value))} /></label>
            <label className="form-field"><span>CARGO TYPE</span><select value={cargoType} onChange={(event) => setCargoType(event.target.value as RouteRequest["cargoType"])}><option value="general">General</option><option value="perishable">Perishable</option><option value="hazardous">Hazardous</option><option value="oversized">Oversized</option><option value="bulk">Bulk</option></select></label>
            <label className="form-field"><span>OPTIMIZE BY</span><select value={metric} onChange={(event) => setMetric(event.target.value as OptimizationMetric)}><option value="cost">Lowest cost</option><option value="distance">Shortest distance</option><option value="time">Fastest delivery</option></select></label>
            <label className="form-field"><span>MAX. BUDGET <small>INR</small></span><input type="number" min="0" placeholder="No limit" value={maxBudget} onChange={(event) => setMaxBudget(event.target.value)} /></label>
            <label className="form-field"><span>MAX. DELIVERY TIME <small>HOURS</small></span><input type="number" min="0" placeholder="No limit" value={maxHours} onChange={(event) => setMaxHours(event.target.value)} /></label>
          </div>
          <div className="form-section-label">AVAILABLE TRANSPORT MODES</div>
          <div className="mode-selector">{(["road", "rail", "air", "sea"] as const).map((mode) => {
            const Icon = mode === "road" ? Truck : mode === "rail" ? TrainFront : mode === "air" ? Plane : Ship;
            return <button key={mode} className={`mode-option ${modes.includes(mode) ? "mode-selected" : ""}`} onClick={() => toggleMode(mode)}><span className="mode-option-icon" style={{ color: modeColors[mode] }}><Icon size={17} /></span>{modeLabels[mode]}<span className={`mode-check ${modes.includes(mode) ? "checked" : ""}`}>{modes.includes(mode) && <Check size={11} />}</span></button>;
          })}</div>
          <div className="form-divider" />
          <div className="priority-header"><div><strong>Optimization priorities</strong><span>Weights must total 100%</span></div><span className={`priority-total ${Object.values(priorities).reduce((a, b) => a + b, 0) === 100 ? "" : "invalid"}`}>{Object.values(priorities).reduce((a, b) => a + b, 0)}%</span></div>
          <div className="priority-sliders">{(["cost", "time", "distance"] as const).map((key) => <label key={key} className="priority-slider"><span>{key[0].toUpperCase() + key.slice(1)} <b>{priorities[key]}%</b></span><input type="range" min="0" max="100" step="5" value={priorities[key]} onChange={(event) => { const next = Number(event.target.value); const delta = next - priorities[key]; const others = (["cost", "time", "distance"] as const).filter((item) => item !== key); const first = others[0]; const second = others[1]; const firstValue = Math.max(0, Math.min(100 - next, priorities[first] - delta / 2)); setPriorities({ ...priorities, [key]: next, [first]: firstValue, [second]: 100 - next - firstValue }); }} /></label>)}</div>
          {routeMessage && <div className={`result-message ${routeMessage.toLowerCase().includes("no connected") || routeMessage.toLowerCase().includes("exceed") ? "message-warning" : ""}`}>{routeMessage}</div>}
          <div className="planner-actions"><button className="button button-secondary" onClick={() => void calculateRoad()} disabled={busy}>{busy ? "Calculating…" : "Calculate road route"}</button><button className="button button-primary" onClick={() => void calculateGraph()} disabled={busy}>{busy ? "Optimizing…" : "Optimize network"}<ArrowRight size={15} /></button></div>
          <div className="planner-coverage"><CircleHelp size={14} /><span>Network optimization uses your saved connections ({connections.length}). Add verified services or manual links in Data Manager.</span></div>
        </section>
        <div className="planner-right">
          <section className="panel planner-map-panel"><div className="panel-heading"><div><h2>Route preview</h2><p>{route?.source ?? "Select locations and calculate an OSRM road route"}</p></div><button className="map-icon-button" title="Map view"><Layers3 size={16} /></button></div>
            <MapPanel height="390px" connections={connections} route={route} source={source} destination={destination} />
            {route && <div className="route-summary"><div><span>DISTANCE</span><strong>{(route.distance / 1000).toFixed(0)} <small>km</small></strong></div><div><span>EST. DURATION</span><strong>{(route.duration / 3600).toFixed(1)} <small>hrs</small></strong></div><div><span>ROUTE TYPE</span><strong>Road <small>· OSRM</small></strong></div></div>}
          </section>
          <section className="panel route-info-panel"><div className="info-icon"><Database size={16} /></div><div><strong>Network data is transparent</strong><p>Only user-entered connections are used for multi-modal optimization. Live road paths use OSRM geometry; mapped infrastructure is queried regionally from OSM.</p></div></section>
        </div>
      </div>
      {!!results.length && <span className="visually-hidden">{results.length} alternatives returned</span>}
    </>
  );
}

function DataManager({ connections, setConnections }: { connections: Connection[]; setConnections: (connections: Connection[]) => void }) {
  const [mode, setMode] = useState<"manual" | "automatic">("manual");
  const [selectedTransport, setSelectedTransport] = useState<TransportMode>("road");
  const [search, setSearch] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const blank = { source: "", destination: "", sourceLat: "", sourceLon: "", destinationLat: "", destinationLon: "", distanceKm: "", cost: "", timeHours: "", capacityTons: "", transferHours: "0", handlingCost: "0", schedule: "", cargoTypes: "", available: true };
  const [form, setForm] = useState(blank);
  const filtered = useMemo(() => connections.filter((item) =>
    item.mode === selectedTransport && `${item.source} ${item.destination} ${item.schedule ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  ), [connections, search, selectedTransport]);
  const reset = () => { setForm(blank); setEditId(null); };
  const save = (event: React.FormEvent) => {
    event.preventDefault();
    const values = [form.distanceKm, form.cost, form.timeHours, form.capacityTons].map(Number);
    const coordinates = [form.sourceLat, form.sourceLon, form.destinationLat, form.destinationLon].map(Number);
    const missingCoordinates = [form.sourceLat, form.sourceLon, form.destinationLat, form.destinationLon].some((value) => !value.trim());
    const allowedCargoTypes = ["general", "perishable", "hazardous", "oversized", "bulk"];
    const cargoTypes = form.cargoTypes.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean) as CargoType[];
    if (!form.source.trim() || !form.destination.trim() || form.source.trim().toLowerCase() === form.destination.trim().toLowerCase() ||
      [values[0], values[2], values[3]].some((value) => !Number.isFinite(value) || value <= 0) ||
      !Number.isFinite(values[1]) || values[1] < 0 || missingCoordinates || coordinates.some((value) => !Number.isFinite(value)) ||
      coordinates[0] < -90 || coordinates[0] > 90 || coordinates[2] < -90 || coordinates[2] > 90 ||
      coordinates[1] < -180 || coordinates[1] > 180 || coordinates[3] < -180 || coordinates[3] > 180 ||
      Number(form.transferHours) < 0 || Number(form.handlingCost) < 0 ||
      cargoTypes.some((cargoType) => !allowedCargoTypes.includes(cargoType))) {
      setNotice("Enter distinct locations, valid endpoint coordinates and positive distance, cost, time and capacity values. Check supported cargo types."); return;
    }
    const record: Connection = {
      id: editId ?? crypto.randomUUID(), source: form.source.trim(), destination: form.destination.trim(),
      mode: selectedTransport, distanceKm: values[0], cost: values[1], timeHours: values[2], capacityTons: values[3],
      available: form.available, transferHours: Number(form.transferHours), handlingCost: Number(form.handlingCost),
      schedule: form.schedule.trim() || undefined, sourceType: "manual", updatedAt: new Date().toISOString(),
      sourceLat: coordinates[0], sourceLon: coordinates[1], destinationLat: coordinates[2], destinationLon: coordinates[3],
      cargoTypes,
    };
    const duplicate = connections.find((item) => item.id !== editId && item.mode === record.mode &&
      item.source.toLowerCase() === record.source.toLowerCase() && item.destination.toLowerCase() === record.destination.toLowerCase());
    if (duplicate) { setNotice("A connection with this mode, origin and destination already exists."); return; }
    setConnections(editId ? connections.map((item) => item.id === editId ? record : item) : [record, ...connections]);
    setNotice(editId ? "Connection updated." : "Manual connection saved."); reset();
  };
  const startEdit = (record: Connection) => {
    setSelectedTransport(record.mode); setEditId(record.id);
    setForm({ source: record.source, destination: record.destination, sourceLat: String(record.sourceLat ?? ""), sourceLon: String(record.sourceLon ?? ""), destinationLat: String(record.destinationLat ?? ""), destinationLon: String(record.destinationLon ?? ""), distanceKm: String(record.distanceKm), cost: String(record.cost), timeHours: String(record.timeHours), capacityTons: String(record.capacityTons), transferHours: String(record.transferHours), handlingCost: String(record.handlingCost), schedule: record.schedule ?? "", cargoTypes: record.cargoTypes?.join(", ") ?? "", available: record.available });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const importFile = async (file?: File) => {
    if (!file) return;
    try {
      const isExcel = /\.(xlsx|xls)$/i.test(file.name);
      let rows: unknown[][];
      if (isExcel) {
        if (/\.xls$/i.test(file.name)) throw new Error("Legacy .xls files are not supported. Save the workbook as .xlsx or CSV.");
        const readXlsxFile = (await import("read-excel-file/browser")).default;
        const [firstSheet] = await readXlsxFile(file);
        if (!firstSheet) throw new Error("The spreadsheet does not contain a worksheet.");
        rows = firstSheet.data;
      } else {
        rows = parseCsv(await file.text());
      }
      if (rows.length < 2) throw new Error("CSV must include a header and at least one connection.");
      const headers = rows[0].map((value) => String(value).trim().toLowerCase());
      const index = (name: string) => headers.indexOf(name);
      const required = ["source", "destination", "mode", "distancekm", "cost", "timehours", "capacitytons", "sourcelat", "sourcelon", "destinationlat", "destinationlon"];
      if (required.some((key) => index(key) < 0)) throw new Error(`Spreadsheet headers must include: ${required.join(", ")}.`);
      const imported: Connection[] = rows.slice(1).map((row, i) => {
        const values = row.map((value) => String(value).trim());
        const modeValue = values[index("mode")].toLowerCase() as TransportMode;
        const numeric = ["distancekm", "cost", "timehours", "capacitytons", "sourcelat", "sourcelon", "destinationlat", "destinationlon"].map((key) => Number(values[index(key)]));
        const available = index("available") < 0 ? true : values[index("available")].toLowerCase() !== "false";
        const cargoTypes: CargoType[] = index("cargotypes") < 0 || !values[index("cargotypes")]
          ? []
          : values[index("cargotypes")].split("|").map((value) => value.trim().toLowerCase()) as CargoType[];
        if (!["road", "rail", "air", "sea"].includes(modeValue) ||
          [numeric[0], numeric[2], numeric[3]].some((value) => !Number.isFinite(value) || value <= 0) ||
          !Number.isFinite(numeric[1]) || numeric[1] < 0 ||
          numeric.slice(4).some((value) => !Number.isFinite(value)) ||
          !values[index("source")] || !values[index("destination")] ||
          ["sourcelat", "sourcelon", "destinationlat", "destinationlon"].some((key) => !values[index(key)]) ||
          numeric[4] < -90 || numeric[4] > 90 || numeric[6] < -90 || numeric[6] > 90 ||
          numeric[5] < -180 || numeric[5] > 180 || numeric[7] < -180 || numeric[7] > 180 ||
          cargoTypes.some((cargoType) => !["general", "perishable", "hazardous", "oversized", "bulk"].includes(cargoType))) throw new Error(`Invalid connection on spreadsheet row ${i + 2}.`);
        return {
          id: crypto.randomUUID(), source: values[index("source")], destination: values[index("destination")],
          mode: modeValue, distanceKm: numeric[0], cost: numeric[1], timeHours: numeric[2], capacityTons: numeric[3],
          available, transferHours: 0, handlingCost: 0, sourceType: "manual", updatedAt: new Date().toISOString(),
          sourceLat: numeric[4], sourceLon: numeric[5], destinationLat: numeric[6], destinationLon: numeric[7], cargoTypes,
        };
      });
      const existingKeys = new Set(connections.map((edge) => `${edge.mode}:${edge.source.toLowerCase()}:${edge.destination.toLowerCase()}`));
      const unique = imported.filter((edge) => {
        const key = `${edge.mode}:${edge.source.toLowerCase()}:${edge.destination.toLowerCase()}`;
        if (existingKeys.has(key)) return false;
        existingKeys.add(key); return true;
      });
      setConnections([...unique, ...connections]);
      setNotice(`Imported ${unique.length} connection${unique.length === 1 ? "" : "s"}${imported.length !== unique.length ? "; duplicates skipped" : ""}.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not import spreadsheet."); }
  };
  const exportCsv = () => {
    const header = "source,destination,mode,distanceKm,cost,timeHours,capacityTons,sourceLat,sourceLon,destinationLat,destinationLon,available,cargoTypes";
    const escape = (value: string | number | boolean) => `"${String(value).replace(/"/g, '""')}"`;
    const lines = connections.map((item) => [item.source, item.destination, item.mode, item.distanceKm, item.cost, item.timeHours, item.capacityTons, item.sourceLat, item.sourceLon, item.destinationLat, item.destinationLon, item.available, item.cargoTypes?.join("|") ?? ""].map((value) => escape(value ?? "")).join(","));
    const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv" });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "logihelp-connections.csv"; link.click(); URL.revokeObjectURL(link.href);
  };
  const remove = (id: string) => {
    if (!window.confirm("Delete this connection? This cannot be undone.")) return;
    setConnections(connections.filter((item) => item.id !== id)); setNotice("Connection deleted.");
  };
  return (
    <>
      <PageTitle eyebrow="NETWORK DATA" title="Transportation data manager" description="Manage manual connection records and inspect configured infrastructure sources." />
      <div className="data-mode-switch"><div><strong>Data collection mode</strong><span>Switch modes without changing saved connection records.</span></div><div className="segmented-control"><button className={mode === "automatic" ? "active" : ""} onClick={() => setMode("automatic")}><Activity size={14} />Automatic</button><button className={mode === "manual" ? "active" : ""} onClick={() => setMode("manual")}><Settings2 size={14} />Manual</button></div></div>
      {mode === "automatic" ? (
        <section className="panel automatic-panel"><div className="panel-heading"><div><h2>Configured data providers</h2><p>Provider access is on-demand; no live service connection is assumed.</p></div><span className="tag tag-neutral">ON-DEMAND</span></div>
          <div className="provider-list">
            {[
              { mode: "road" as const, label: "Road network & routing", provider: "OpenStreetMap · OSRM", detail: "Regional road features and road-route geometry", Icon: Truck },
              { mode: "rail" as const, label: "Railways & stations", provider: "OpenStreetMap", detail: "Mapped railway infrastructure only; no schedule or freight feed", Icon: TrainFront },
              { mode: "air" as const, label: "Airports & aerodromes", provider: "OpenStreetMap", detail: "Mapped airport infrastructure only; no flight service feed", Icon: Plane },
              { mode: "sea" as const, label: "Ports & maritime infrastructure", provider: "OpenStreetMap", detail: "Mapped port facilities only; no shipping service feed", Icon: Ship },
            ].map(({ mode: m, label, provider, detail, Icon }) => <div className="provider-row" key={m}><span className="provider-icon" style={{ color: modeColors[m] }}><Icon size={18} /></span><div className="provider-copy"><strong>{label}</strong><span>{detail}</span></div><div className="provider-name">{provider}</div><span className="tag tag-neutral">Not queried</span></div>)}
          </div>
          <div className="provider-note"><CircleHelp size={15} /><span>Queries run only when you open or move the map. Regional OSM features are cached for 15 minutes by the backend. OSM features do not confirm an active transport service.</span></div>
        </section>
      ) : (
        <div className="data-manager-grid">
          <section className="panel connection-editor"><div className="panel-heading"><div><h2>{editId ? "Edit connection" : "Add a connection"}</h2><p>Manual service records stay separate from imported map features.</p></div><span className="tag tag-blue">MANUAL DATA</span></div>
            <div className="transport-tabs">{(["road", "rail", "air", "sea"] as const).map((m) => <button key={m} className={selectedTransport === m ? "active" : ""} onClick={() => { setSelectedTransport(m); reset(); }} style={{ "--mode-color": modeColors[m] } as React.CSSProperties}>{modeLabels[m]}</button>)}</div>
            <form className="connection-form" onSubmit={save}>
              <div className="form-two-col"><label className="form-field"><span>SOURCE / NODE</span><input value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value })} placeholder="e.g. Hub A" /></label><label className="form-field"><span>DESTINATION / NODE</span><input value={form.destination} onChange={(event) => setForm({ ...form, destination: event.target.value })} placeholder="e.g. Hub B" /></label>
                <label className="form-field"><span>ORIGIN COORDINATES <small>LATITUDE</small></span><input type="number" min="-90" max="90" step="any" value={form.sourceLat} onChange={(event) => setForm({ ...form, sourceLat: event.target.value })} placeholder="e.g. 19.076" /></label>
                <label className="form-field"><span>ORIGIN COORDINATES <small>LONGITUDE</small></span><input type="number" min="-180" max="180" step="any" value={form.sourceLon} onChange={(event) => setForm({ ...form, sourceLon: event.target.value })} placeholder="e.g. 72.878" /></label>
                <label className="form-field"><span>DESTINATION COORDINATES <small>LATITUDE</small></span><input type="number" min="-90" max="90" step="any" value={form.destinationLat} onChange={(event) => setForm({ ...form, destinationLat: event.target.value })} placeholder="e.g. 18.520" /></label>
                <label className="form-field"><span>DESTINATION COORDINATES <small>LONGITUDE</small></span><input type="number" min="-180" max="180" step="any" value={form.destinationLon} onChange={(event) => setForm({ ...form, destinationLon: event.target.value })} placeholder="e.g. 73.857" /></label>
                <label className="form-field"><span>DISTANCE <small>KM</small></span><input type="number" min="0.1" step="0.1" value={form.distanceKm} onChange={(event) => setForm({ ...form, distanceKm: event.target.value })} placeholder="0" /></label>
                <label className="form-field"><span>TRANSPORT COST <small>INR / TONNE</small></span><input type="number" min="0" step="0.01" value={form.cost} onChange={(event) => setForm({ ...form, cost: event.target.value })} placeholder="0" /></label>
                <label className="form-field"><span>EST. TRAVEL TIME <small>HOURS</small></span><input type="number" min="0.1" step="0.1" value={form.timeHours} onChange={(event) => setForm({ ...form, timeHours: event.target.value })} placeholder="0" /></label>
                <label className="form-field"><span>CAPACITY <small>TONNES</small></span><input type="number" min="0.1" step="0.1" value={form.capacityTons} onChange={(event) => setForm({ ...form, capacityTons: event.target.value })} placeholder="0" /></label>
                <label className="form-field"><span>TRANSFER TIME <small>HOURS</small></span><input type="number" min="0" step="0.1" value={form.transferHours} onChange={(event) => setForm({ ...form, transferHours: event.target.value })} /></label>
                <label className="form-field"><span>HANDLING COST <small>INR / TONNE</small></span><input type="number" min="0" step="0.01" value={form.handlingCost} onChange={(event) => setForm({ ...form, handlingCost: event.target.value })} /></label>
                <label className="form-field"><span>AVAILABILITY</span><select value={form.available ? "available" : "unavailable"} onChange={(event) => setForm({ ...form, available: event.target.value === "available" })}><option value="available">Available</option><option value="unavailable">Unavailable</option></select></label>
                <label className="form-field"><span>SUPPORTED CARGO TYPES <small>OPTIONAL · COMMA-SEPARATED</small></span><input value={form.cargoTypes} onChange={(event) => setForm({ ...form, cargoTypes: event.target.value })} placeholder="general, bulk" /></label>
                <label className="form-field form-full"><span>SCHEDULE / SERVICE NOTE <small>OPTIONAL</small></span><input value={form.schedule} onChange={(event) => setForm({ ...form, schedule: event.target.value })} placeholder="Optional operator or schedule details" /></label>
              </div>
              <div className="editor-actions"><label className="button button-secondary import-button"><Download size={15} />Import CSV / Excel<input type="file" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={(event) => { void importFile(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label><div>{editId && <button type="button" className="text-button" onClick={reset}>Cancel</button>}<button type="submit" className="button button-primary">{editId ? "Save changes" : "Add connection"}<ArrowRight size={15} /></button></div></div>
            </form>
            {notice && <div className="result-message">{notice}</div>}
          </section>
          <section className="panel connection-list-panel"><div className="panel-heading"><div><h2>Saved connections</h2><p>{connections.length} total across all modes</p></div><button className="icon-text-button" onClick={exportCsv} disabled={!connections.length}><Download size={14} />Export CSV</button></div>
            <div className="connection-list-controls"><div className="search-control"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search connections" /></div><span className="connection-count">{filtered.length} {selectedTransport} records</span></div>
            <div className="transport-tabs list-tabs">{(["road", "rail", "air", "sea"] as const).map((m) => <button key={m} className={selectedTransport === m ? "active" : ""} onClick={() => { setSelectedTransport(m); reset(); }} style={{ "--mode-color": modeColors[m] } as React.CSSProperties}>{modeLabels[m]} <span>{connections.filter((item) => item.mode === m).length}</span></button>)}</div>
            <div className="connections-table-wrap"><table className="connections-table"><thead><tr><th>CONNECTION</th><th>DISTANCE</th><th>COST / T</th><th>CAPACITY</th><th>STATUS</th><th></th></tr></thead><tbody>{filtered.map((item) => <tr key={item.id}><td><strong>{item.source}</strong><span className="connection-destination"><ArrowRight size={12} />{item.destination}</span></td><td>{item.distanceKm.toLocaleString()} km</td><td>₹{item.cost.toLocaleString()}</td><td>{item.capacityTons} t</td><td><span className={`tag ${item.available ? "tag-green" : "tag-neutral"}`}>{item.available ? "AVAILABLE" : "OFFLINE"}</span></td><td><button className="row-action" title="Edit" onClick={() => startEdit(item)}><Settings2 size={15} /></button><button className="row-action danger-action" title="Delete" onClick={() => remove(item.id)}><X size={15} /></button></td></tr>)}</tbody></table>
              {!filtered.length && <div className="empty-list"><div className="empty-icon"><Database size={18} /></div><strong>No {selectedTransport} connections saved</strong><span>Add a connection or import a CSV to build your optimization network.</span></div>}
            </div>
            <div className="data-manager-footnote"><span className="manual-dot" />Manual records · Stored in this browser</div>
          </section>
        </div>
      )}
    </>
  );
}

function OptimizationWorkspace({ connections, results, setPage }: { connections: Connection[]; results: RouteResult[]; setPage: (page: Page) => void }) {
  const [selected, setSelected] = useState(0);
  const [flowQuantities, setFlowQuantities] = useState("10, 10");
  const [flowResult, setFlowResult] = useState<{
    requestedTons: number; deliveredTons: number; remainingTons: number; totalCost: number;
    complete: boolean; shipmentCount: number; allocations: Array<{ connectionId: string; tons: number }>; explanation: string;
  } | null>(null);
  const [flowError, setFlowError] = useState("");
  const [flowBusy, setFlowBusy] = useState(false);
  const route = results[selected];
  const edgeMap = new Map(connections.map((edge) => [edge.id, edge]));
  const runFlow = async () => {
    if (!route) return;
    const amounts = flowQuantities.split(",").map((value) => Number(value.trim()));
    if (!amounts.length || amounts.some((value) => !Number.isFinite(value) || value <= 0)) {
      setFlowError("Enter one or more positive shipment quantities in tonnes, separated by commas."); return;
    }
    const shipments = amounts.map((quantityTons) => ({
      id: crypto.randomUUID(), source: route.stops[0], destination: route.stops[route.stops.length - 1], quantityTons,
    }));
    setFlowBusy(true); setFlowError("");
    try {
      const response = await requestJson<typeof flowResult>("/api/min-cost-flow", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connections, shipments, modes: route.modes }),
      });
      setFlowResult(response);
    } catch (error) { setFlowError(error instanceof Error ? error.message : "Min-cost flow calculation failed."); }
    finally { setFlowBusy(false); }
  };
  return (
    <>
      <PageTitle eyebrow="GRAPH ALGORITHM ENGINE" title="Optimization workspace" description="Inspect the ranked routes and connection-level weights used by the network engine." action={<button className="button button-secondary" onClick={() => setPage("Route planner")}><SlidersHorizontal size={15} />Edit constraints</button>} />
      {!results.length ? <section className="panel workspace-empty"><div className="empty-icon"><Activity size={20} /></div><h2>No optimization results</h2><p>Run a route optimization using your saved connections to inspect explored nodes, path weights and feasible alternatives.</p><button className="button button-primary" onClick={() => setPage("Route planner")}>Open route planner <ArrowRight size={15} /></button></section> :
        <div className="workspace-layout">
          <div className="workspace-main">
            <section className="panel results-panel"><div className="panel-heading"><div><h2>Ranked route alternatives</h2><p>Weighted path ranking from the saved connection graph</p></div><span className="tag tag-green">{results.length} FEASIBLE</span></div>
              {results.map((item, index) => <button key={item.connectionIds.join("-")} className={`alternative-row ${selected === index ? "selected" : ""}`} onClick={() => setSelected(index)}>
                <span className="alternative-rank">{String(index + 1).padStart(2, "0")}</span><span className="alternative-copy"><strong>{item.stops.join("  →  ")}</strong><small>{item.modes.map((mode) => modeLabels[mode]).join(" / ") || "No mode"} · {item.stops.length - 2} transfer{item.stops.length === 3 ? "" : "s"}</small></span><span className="alternative-metrics"><b>₹{item.cost.toLocaleString()}</b><small>{item.distanceKm.toLocaleString()} km · {item.timeHours} h</small></span><span className="route-score">{(item.score * 100).toFixed(0)}<small>score</small></span>
              </button>)}
            </section>
            {route && <section className="panel path-detail-panel"><div className="panel-heading"><div><h2>Selected path details</h2><p>Connection-by-connection breakdown · source data preserved</p></div><span className="tag tag-blue">ROUTE {String(selected + 1).padStart(2, "0")}</span></div>
              <div className="path-flow">{route.connectionIds.map((id, index) => { const edge = edgeMap.get(id); return edge ? <div className="path-edge" key={id}><div className="path-node"><span className="path-node-dot" />{edge.source}</div><div className="path-link"><span className="path-link-line" style={{ borderColor: modeColors[edge.mode] }} /><span className="path-link-info"><b style={{ color: modeColors[edge.mode] }}>{modeLabels[edge.mode]}</b>{edge.distanceKm} km · ₹{(edge.cost + edge.handlingCost).toLocaleString()} · {edge.timeHours + edge.transferHours} h <small>Capacity {edge.capacityTons} t · {edge.sourceType} record</small></span></div>{index === route.connectionIds.length - 1 && <div className="path-node"><span className="path-node-dot final-dot" />{edge.destination}</div>}</div> : null; })}</div>
            </section>}
            {route && <section className="panel flow-panel"><div className="panel-heading"><div><h2>Min-cost flow · shipment batch</h2><p>Capacity-aware allocation across the selected route’s modes</p></div><span className="tag tag-blue">PER TONNE COST</span></div>
              <div className="flow-input-row"><label className="form-field"><span>SHIPMENT QUANTITIES <small>TONNES · COMMA-SEPARATED</small></span><input value={flowQuantities} onChange={(event) => setFlowQuantities(event.target.value)} placeholder="e.g. 8, 12, 4" /></label><button className="button button-primary" onClick={() => void runFlow()} disabled={flowBusy}>{flowBusy ? "Allocating…" : "Run min-cost flow"}<ArrowRight size={14} /></button></div>
              {flowError && <div className="result-message message-warning">{flowError}</div>}
              {flowResult && <div className="flow-result"><div className={`flow-status ${flowResult.complete ? "" : "incomplete"}`}><span>{flowResult.complete ? <Check size={14} /> : <CircleHelp size={14} />}</span><div><strong>{flowResult.explanation}</strong><small>{flowResult.deliveredTons} / {flowResult.requestedTons} tonnes delivered · Total allocated cost ₹{flowResult.totalCost.toLocaleString()}</small></div></div>
                {!!flowResult.allocations.length && <div className="flow-allocations">{flowResult.allocations.map((allocation) => <div key={allocation.connectionId}><span>{edgeMap.get(allocation.connectionId)?.source} → {edgeMap.get(allocation.connectionId)?.destination}</span><b>{allocation.tons} t allocated</b></div>)}</div>}
              </div>}
            </section>}
          </div>
          <div className="workspace-side">
            {route && <section className="panel selected-route-panel"><div className="panel-heading"><div><h2>Route summary</h2><p>Constraint-checked outcome</p></div><span className="route-check"><Check size={15} /></span></div><div className="summary-metrics"><div><span>TOTAL COST</span><strong>₹{route.cost.toLocaleString()}</strong></div><div><span>DISTANCE</span><strong>{route.distanceKm.toLocaleString()} <small>km</small></strong></div><div><span>EST. TIME</span><strong>{route.timeHours} <small>hrs</small></strong></div><div><span>TRANSFERS</span><strong>{Math.max(0, route.stops.length - 2)}</strong></div></div><div className="summary-footnote"><Check size={13} />Capacity and availability checked for each edge</div></section>}
            <section className="panel algorithm-panel"><div className="panel-heading"><div><h2>Algorithm run</h2><p>Actual graph search · no ML prediction</p></div></div>            <div className="algo-step"><span className="algo-number">01</span><div><strong>Dijkstra shortest path</strong><small>Non-negative edge weights</small></div><span className="tag tag-green">COMPLETE</span></div><div className="algo-step"><span className="algo-number">02</span><div><strong>Yen's K-shortest paths</strong><small>Loop-free alternatives</small></div><span className="tag tag-green">COMPLETE</span></div><div className="algo-step"><span className="algo-number">03</span><div><strong>Greedy heuristic</strong><small>Local edge-cost choice</small></div><span className="tag tag-green">RANKED</span></div><div className="algo-step"><span className="algo-number">04</span><div><strong>Weighted multi-criteria</strong><small>Normalized cost, time & distance</small></div><span className="tag tag-green">RANKED</span></div><div className="algo-disclaimer"><CircleHelp size={14} /><span>Min-cost flow is available for shipment batches on this workspace; costs are interpreted per tonne and residual capacity is shared.</span></div><div className="graph-footnote"><Database size={14} />{connections.length} saved edges in graph</div></section>
          </div>
        </div>}
    </>
  );
}

function RouteComparison({ results, connections, setPage }: { results: RouteResult[]; connections: Connection[]; setPage: (page: Page) => void }) {
  const [selected, setSelected] = useState(0);
  const names = new Map(connections.map((connection) => [connection.id, connection]));
  const exportComparison = () => {
    const header = ["rank", "origin", "destination", "cost_inr", "distance_km", "time_hours", "modes", "transfers", "weighted_score"];
    const rows = results.map((item, index) => [
      index + 1,
      item.stops[0],
      item.stops[item.stops.length - 1],
      item.cost,
      item.distanceKm,
      item.timeHours,
      item.modes.join("|"),
      Math.max(0, item.stops.length - 2),
      item.score,
    ]);
    const quote = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
    const blob = new Blob([[header, ...rows].map((row) => row.map(quote).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "logihelp-route-comparison.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return (
    <>
      <PageTitle eyebrow="DECISION SUPPORT" title="Route comparison" description="Compare feasible alternatives side by side using consistent cost, time and distance measures." action={<><button className="button button-secondary" onClick={() => setPage("Route planner")}><Plus size={15} />New comparison</button><button className="button button-secondary" onClick={exportComparison} disabled={!results.length}><Download size={15} />Export CSV</button></>} />
      {!results.length ? <section className="panel workspace-empty"><div className="empty-icon"><ArrowDownUp size={20} /></div><h2>No alternatives to compare</h2><p>Run an optimization to generate capacity-checked route alternatives from your connection data.</p><button className="button button-primary" onClick={() => setPage("Route planner")}>Plan a route <ArrowRight size={15} /></button></section> :
        <section className="panel comparison-panel"><div className="panel-heading"><div><h2>Alternative routes</h2><p>Ranked by your selected cost, time and distance priorities</p></div><span className="tag tag-green">{results.length} FEASIBLE ROUTES</span></div>
          <div className="comparison-table-wrap"><table className="comparison-table"><thead><tr><th>MEASURE</th>{results.map((item, index) => <th key={item.connectionIds.join("-")}><button className={`comparison-select ${selected === index ? "selected" : ""}`} onClick={() => setSelected(index)}>{index === 0 ? "PREFERRED" : `OPTION ${index + 1}`}<span>{item.stops[0]} → {item.stops[item.stops.length - 1]}</span></button></th>)}</tr></thead><tbody>
            <tr><th>Estimated cost</th>{results.map((item, index) => <td className={index === selected ? "highlight-cell" : ""} key={item.connectionIds.join("-")}>₹{item.cost.toLocaleString()}</td>)}</tr>
            <tr><th>Distance</th>{results.map((item, index) => <td className={index === selected ? "highlight-cell" : ""} key={item.connectionIds.join("-")}>{item.distanceKm.toLocaleString()} km</td>)}</tr>
            <tr><th>Estimated travel time</th>{results.map((item, index) => <td className={index === selected ? "highlight-cell" : ""} key={item.connectionIds.join("-")}>{item.timeHours} hrs</td>)}</tr>
            <tr><th>Transport modes</th>{results.map((item, index) => <td className={index === selected ? "highlight-cell" : ""} key={item.connectionIds.join("-")}>{item.modes.map((mode) => modeLabels[mode]).join(" · ")}</td>)}</tr>
            <tr><th>Transfers</th>{results.map((item, index) => <td className={index === selected ? "highlight-cell" : ""} key={item.connectionIds.join("-")}>{Math.max(0, item.stops.length - 2)}</td>)}</tr>
            <tr><th>Connections</th>{results.map((item, index) => <td className={index === selected ? "highlight-cell" : ""} key={item.connectionIds.join("-")}>{item.connectionIds.map((id) => names.get(id)?.mode).filter(Boolean).join(" → ")}</td>)}</tr>
            <tr><th>Normalized score</th>{results.map((item, index) => <td className={index === selected ? "highlight-cell" : ""} key={item.connectionIds.join("-")}>{(item.score * 100).toFixed(0)}</td>)}</tr>
          </tbody></table></div>
          <div className="comparison-explanation"><div className="info-icon"><Check size={15} /></div><div><strong>Preferred option is highlighted</strong><p>Scores are normalized within returned alternatives; the lowest score best matches the selected priorities. Cost, distance and time totals include transfer handling.</p></div></div>
        </section>}
    </>
  );
}

function Reports({ connections }: { connections: Connection[] }) {
  const modes = (["road", "rail", "air", "sea"] as const).map((mode) => ({ mode, count: connections.filter((connection) => connection.mode === mode).length }));
  const downloadReport = () => window.print();
  return (
    <>
      <PageTitle eyebrow="NETWORK INSIGHTS" title="Reports & analytics" description="Review the connections in your workspace and print a planning summary." action={<button className="button button-primary" onClick={downloadReport}><FileText size={15} />Print / save PDF</button>} />
      <div className="stats-grid reports-stats"><StatCard title="Saved connections" value={connections.length.toLocaleString()} note="Manual records in browser" icon={ArrowDownUp} tone="blue" /><StatCard title="Total capacity" value={`${connections.reduce((sum, item) => sum + item.capacityTons, 0).toLocaleString()} t`} note="Sum of declared edge capacities" icon={Boxes} tone="teal" /><StatCard title="Mode coverage" value={`${modes.filter((item) => item.count > 0).length} / 4`} note="Modes with saved connections" icon={Layers3} tone="amber" /><StatCard title="Data provenance" value="100%" note="Each manual record source-labeled" icon={Database} tone="violet" /></div>
      <div className="reports-grid"><section className="panel report-panel"><div className="panel-heading"><div><h2>Connections by mode</h2><p>User-entered network records</p></div></div>
          <div className="mode-report-list">{modes.map(({ mode, count }) => <div className="mode-report-row" key={mode}><span className="provider-icon" style={{ color: modeColors[mode] }}>{mode === "road" ? <Truck size={18} /> : mode === "rail" ? <TrainFront size={18} /> : mode === "air" ? <Plane size={18} /> : <Ship size={18} />}</span><span>{modeLabels[mode]}</span><div className="progress-track"><span style={{ width: `${connections.length ? Math.max(3, count / connections.length * 100) : 0}%`, background: modeColors[mode] }} /></div><strong>{count}</strong></div>)}</div>
        </section>
        <section className="panel report-panel"><div className="panel-heading"><div><h2>Data quality & methodology</h2><p>How to interpret this workspace</p></div></div><div className="quality-note"><span className="quality-icon"><Check size={15} /></span><div><strong>Source tracked</strong><p>Manual connections are labeled and stored locally in this browser.</p></div></div><div className="quality-note"><span className="quality-icon muted"><MapIcon size={15} /></span><div><strong>OSM features are infrastructure only</strong><p>Mapped facilities do not imply an available service, schedule or capacity.</p></div></div><div className="quality-note"><span className="quality-icon muted"><Clock3 size={15} /></span><div><strong>No invented historical metrics</strong><p>Charts and shipment volumes are not shown unless actual records are present.</p></div></div></section>
      </div>
      <section className="panel report-table-panel"><div className="panel-heading"><div><h2>Connection register</h2><p>Report-ready record inventory</p></div><button className="text-button" onClick={() => window.print()}><Download size={14} />Export PDF</button></div>
        {!connections.length ? <div className="empty-table"><div className="empty-icon"><Factory size={18} /></div><div><strong>No connection data to report</strong><p>Add service records in Data Manager to populate transportation analysis.</p></div></div> : <div className="table-scroll"><table><thead><tr><th>SOURCE</th><th>DESTINATION</th><th>MODE</th><th>DISTANCE</th><th>COST</th><th>CAPACITY</th><th>UPDATED</th></tr></thead><tbody>{connections.map((item) => <tr key={item.id}><td>{item.source}</td><td>{item.destination}</td><td><span className="mode-badge" style={{ color: modeColors[item.mode], borderColor: `${modeColors[item.mode]}40` }}>{item.mode}</span></td><td>{item.distanceKm} km</td><td>₹{item.cost.toLocaleString()}</td><td>{item.capacityTons} t</td><td>{new Date(item.updatedAt).toLocaleDateString()}</td></tr>)}</tbody></table></div>}
      </section>
    </>
  );
}

function SettingsPage({ setPage }: { setPage: (page: Page) => void }) {
  const [preferences, setPreferences] = useState(readPlannerPreferences);
  const [notice, setNotice] = useState("");
  const [apiStatus, setApiStatus] = useState<"idle" | "checking" | "online" | "error">("idle");
  const [apiMessage, setApiMessage] = useState("");
  const toggleMode = (mode: TransportMode) => {
    setPreferences((current) => {
      const modes = current.modes.includes(mode)
        ? current.modes.filter((item) => item !== mode)
        : [...current.modes, mode];
      return { ...current, modes };
    });
  };
  const save = () => {
    if (!Number.isFinite(preferences.cargoWeight) || preferences.cargoWeight <= 0) {
      setNotice("Default shipment weight must be greater than zero.");
      return;
    }
    if (!preferences.modes.length) {
      setNotice("Select at least one default transport mode.");
      return;
    }
    localStorage.setItem(plannerPreferencesKey, JSON.stringify(preferences));
    setNotice("Planner defaults saved in this browser.");
  };
  const reset = () => {
    localStorage.removeItem(plannerPreferencesKey);
    setPreferences(defaultPlannerPreferences);
    setNotice("Planner defaults restored.");
  };
  const clearSavedPlaces = () => {
    if (!window.confirm("Clear saved and recent places from this browser?")) return;
    localStorage.removeItem("logihelp-recent-places");
    localStorage.removeItem("logihelp-favorite-places");
    setNotice("Saved and recent places cleared.");
  };
  const checkApi = async () => {
    setApiStatus("checking");
    setApiMessage("");
    try {
      const result = await requestJson<{ status: string; service: string }>("/api/health");
      setApiStatus("online");
      setApiMessage(`${result.service} is responding.`);
    } catch (error) {
      setApiStatus("error");
      setApiMessage(error instanceof Error ? error.message : "API health check failed.");
    }
  };
  return (
    <>
      <PageTitle eyebrow="WORKSPACE PREFERENCES" title="Settings" description="Configure route-planning defaults and check the deployed API connection." />
      <div className="settings-grid">
        <section className="panel settings-panel">
          <div className="panel-heading"><div><h2>Route-planner defaults</h2><p>Applied when you open a new route-planning session.</p></div><span className="tag tag-blue">THIS BROWSER</span></div>
          <div className="settings-fields">
            <label className="form-field"><span>DEFAULT SHIPMENT WEIGHT <small>TONNES</small></span><input type="number" min="0.1" step="0.1" value={preferences.cargoWeight} onChange={(event) => setPreferences({ ...preferences, cargoWeight: Number(event.target.value) })} /></label>
            <label className="form-field"><span>DEFAULT CARGO TYPE</span><select value={preferences.cargoType} onChange={(event) => setPreferences({ ...preferences, cargoType: event.target.value as CargoType })}><option value="general">General</option><option value="perishable">Perishable</option><option value="hazardous">Hazardous</option><option value="oversized">Oversized</option><option value="bulk">Bulk</option></select></label>
            <label className="form-field settings-full"><span>DEFAULT OPTIMIZATION GOAL</span><select value={preferences.metric} onChange={(event) => setPreferences({ ...preferences, metric: event.target.value as OptimizationMetric })}><option value="cost">Lowest cost</option><option value="distance">Shortest distance</option><option value="time">Fastest delivery</option></select></label>
          </div>
          <div className="settings-mode-section"><div className="form-section-label">DEFAULT AVAILABLE MODES</div><div className="settings-mode-list">{(["road", "rail", "air", "sea"] as const).map((mode) => <label key={mode} className="settings-mode"><input type="checkbox" checked={preferences.modes.includes(mode)} onChange={() => toggleMode(mode)} /><span className="legend-dot" style={{ backgroundColor: modeColors[mode] }} />{modeLabels[mode]}</label>)}</div></div>
          {notice && <div className="result-message">{notice}</div>}
          <div className="settings-actions"><button className="text-button" onClick={reset}>Restore defaults</button><button className="button button-primary" onClick={save}><Check size={14} />Save preferences</button></div>
        </section>
        <div className="settings-side">
          <section className="panel api-status-panel">
            <div className="panel-heading"><div><h2>Deployment health</h2><p>Check that Vercel can invoke the LogiHelp API.</p></div><span className={`api-health-indicator ${apiStatus}`} /></div>
            <div className="api-status-content"><div className={`api-status-icon ${apiStatus}`}><Activity size={18} /></div><div><strong>{apiStatus === "checking" ? "Checking connection…" : apiStatus === "online" ? "API reachable" : apiStatus === "error" ? "API check failed" : "Not checked yet"}</strong><p>{apiMessage || "Runs a live request to /api/health from this deployment."}</p></div></div>
            <div className="api-status-actions"><button className="button button-secondary" onClick={() => void checkApi()} disabled={apiStatus === "checking"}>{apiStatus === "checking" ? "Checking…" : "Check API connection"}</button></div>
          </section>
          <section className="panel settings-data-panel">
            <div className="panel-heading"><div><h2>Data & providers</h2><p>Current workspace storage and sources</p></div></div>
            <div className="settings-provider-row"><span className="provider-icon"><MapIcon size={16} /></span><div><strong>OpenStreetMap</strong><small>Regional map features · on demand</small></div><span className="tag tag-neutral">MAP DATA</span></div>
            <div className="settings-provider-row"><span className="provider-icon"><Navigation size={16} /></span><div><strong>OSRM + geocoding</strong><small>Road routes and India place search</small></div><span className="tag tag-neutral">ON DEMAND</span></div>
            <div className="settings-storage-note"><Database size={14} /><span>Manual connections and planner preferences are stored in this browser; they are not shared across accounts or devices.</span></div>
            <div className="settings-actions"><button className="button button-secondary" onClick={() => setPage("Data manager")}>Open data manager <ArrowRight size={14} /></button><button className="text-button danger-text-button" onClick={clearSavedPlaces}>Clear saved places</button></div>
          </section>
        </div>
      </div>
    </>
  );
}

export default function App() {
  const [page, setPage] = useState<Page>("Overview");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [connections, setConnections] = useConnections();
  const [routeResults, setRouteResults] = useState<RouteResult[]>([]);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const content = page === "Overview" ? <Dashboard connections={connections} setPage={setPage} /> :
    page === "Infrastructure map" ? <InfrastructurePage setPage={setPage} connections={connections} /> :
      page === "Route planner" ? <RoutePlanner connections={connections} setPage={setPage} onCalculated={setRouteResults} /> :
        page === "Data manager" ? <DataManager connections={connections} setConnections={setConnections} /> :
          page === "Optimization workspace" ? <OptimizationWorkspace connections={connections} results={routeResults} setPage={setPage} /> :
            page === "Route comparison" ? <RouteComparison results={routeResults} connections={connections} setPage={setPage} /> :
              page === "Reports & analytics" ? <Reports connections={connections} /> :
                <SettingsPage setPage={setPage} />;
  return (
    <div className="app-shell">
      <Sidebar page={page} setPage={setPage} open={sidebarOpen} onClose={closeSidebar} />
      <div className="main-shell"><Header page={page} onMenu={() => setSidebarOpen(true)} /><main className="page-content">{content}</main><footer className="app-footer"><span>LogiHelp Transport Network Operations</span><span>Map data © OpenStreetMap contributors · Route data via OSRM</span></footer></div>
    </div>
  );
}
