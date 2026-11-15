export type TransportMode = "road" | "rail" | "air" | "sea";
export type OptimizationMetric = "cost" | "distance" | "time";
export type CargoType = "general" | "perishable" | "hazardous" | "oversized" | "bulk";

export interface Connection {
  id: string;
  source: string;
  destination: string;
  mode: TransportMode;
  distanceKm: number;
  cost: number;
  timeHours: number;
  capacityTons: number;
  available: boolean;
  transferHours: number;
  handlingCost: number;
  schedule?: string;
  sourceType: "manual" | "demo";
  updatedAt: string;
  sourceLat?: number;
  sourceLon?: number;
  destinationLat?: number;
  destinationLon?: number;
  cargoTypes?: CargoType[];
}

export interface RouteRequest {
  source: string;
  destination: string;
  cargoWeight: number;
  cargoType: CargoType;
  maxBudget?: number;
  maxHours?: number;
  modes: TransportMode[];
  metric: OptimizationMetric;
  priorities: { cost: number; time: number; distance: number };
  alternatives: number;
}

export interface RouteResult {
  connectionIds: string[];
  stops: string[];
  modes: TransportMode[];
  distanceKm: number;
  cost: number;
  timeHours: number;
  score: number;
}

export interface InfrastructureFeature {
  type: "Feature";
  id: string;
  geometry: {
    type: "Point" | "LineString" | "Polygon";
    coordinates: unknown;
  };
  properties: Record<string, string | number | undefined>;
}

export interface InfrastructureResponse {
  type: "FeatureCollection";
  features: InfrastructureFeature[];
  source: "OpenStreetMap";
  retrievedAt: string;
}
