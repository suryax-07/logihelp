import type { Connection, RouteRequest } from "../shared/types";
import { optimizeFlow, optimizeRoutes, type FlowShipment } from "../server/algorithms";

type RouteOptimizationMessage = {
  type: "routes";
  connections: Connection[];
  request: RouteRequest;
};
type FlowOptimizationMessage = {
  type: "flow";
  connections: Connection[];
  shipments: FlowShipment[];
  modes: Connection["mode"][];
};

self.addEventListener("message", (event: MessageEvent<RouteOptimizationMessage | FlowOptimizationMessage>) => {
  try {
    const result = event.data.type === "routes"
      ? optimizeRoutes(event.data.connections, event.data.request)
      : optimizeFlow(event.data.connections, event.data.shipments, event.data.modes);
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "Optimization failed." });
  }
});
