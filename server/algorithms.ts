import type { Connection, RouteRequest, RouteResult } from "../shared/types";

interface SearchRoute {
  edges: Connection[];
  nodes: string[];
  weight: number;
}

export interface FlowShipment {
  id: string;
  source: string;
  destination: string;
  quantityTons: number;
}

interface ResidualEdge {
  to: string;
  reverseIndex: number;
  capacity: number;
  costPerTon: number;
  connectionId?: string;
  forward: boolean;
}

const edgeWeight = (edge: Connection, metric: RouteRequest["metric"]) => {
  if (metric === "distance") return edge.distanceKm;
  if (metric === "time") return edge.timeHours + edge.transferHours;
  return edge.cost + edge.handlingCost;
};

function eligible(edge: Connection, request: RouteRequest) {
  return edge.available &&
    edge.capacityTons >= request.cargoWeight &&
    request.modes.includes(edge.mode) &&
    (!edge.cargoTypes?.length || edge.cargoTypes.includes(request.cargoType));
}

function shortestPath(
  edges: Connection[],
  request: RouteRequest,
  bannedEdges: Set<string> = new Set(),
  bannedNodes: Set<string> = new Set(),
): SearchRoute | undefined {
  const adjacency = new Map<string, Connection[]>();
  for (const edge of edges) {
    if (!eligible(edge, request) || bannedEdges.has(edge.id) ||
      bannedNodes.has(edge.source) || bannedNodes.has(edge.destination)) continue;
    const list = adjacency.get(edge.source) ?? [];
    list.push(edge);
    adjacency.set(edge.source, list);
  }

  const distances = new Map<string, number>([[request.source, 0]]);
  const previous = new Map<string, { node: string; edge: Connection }>();
  const visited = new Set<string>();

  while (true) {
    let current: string | undefined;
    let currentDistance = Infinity;
    for (const [node, distance] of distances) {
      if (!visited.has(node) && distance < currentDistance) {
        current = node;
        currentDistance = distance;
      }
    }
    if (current === undefined) break;
    if (current === request.destination) break;
    visited.add(current);

    for (const edge of adjacency.get(current) ?? []) {
      const nextDistance = currentDistance + edgeWeight(edge, request.metric);
      if (nextDistance < (distances.get(edge.destination) ?? Infinity)) {
        distances.set(edge.destination, nextDistance);
        previous.set(edge.destination, { node: current, edge });
      }
    }
  }

  if (!distances.has(request.destination)) return undefined;
  const pathEdges: Connection[] = [];
  const pathNodes = [request.destination];
  let node = request.destination;
  while (node !== request.source) {
    const step = previous.get(node);
    if (!step) return undefined;
    pathEdges.unshift(step.edge);
    node = step.node;
    pathNodes.unshift(node);
  }
  return { edges: pathEdges, nodes: pathNodes, weight: distances.get(request.destination)! };
}

function routeSignature(route: SearchRoute) {
  return route.edges.map((edge) => edge.id).join("|");
}

function yenKShortest(edges: Connection[], request: RouteRequest, limit: number): SearchRoute[] {
  const first = shortestPath(edges, request);
  if (!first) return [];
  const accepted = [first];
  const candidates: SearchRoute[] = [];
  const candidateKeys = new Set<string>();

  for (let k = 1; k < limit; k += 1) {
    const previousRoute = accepted[k - 1];
    for (let i = 0; i < previousRoute.nodes.length - 1; i += 1) {
      const rootNodes = previousRoute.nodes.slice(0, i + 1);
      const rootEdges = previousRoute.edges.slice(0, i);
      const spurNode = rootNodes[rootNodes.length - 1];
      const banned = new Set<string>();
      for (const route of accepted) {
        if (route.nodes.length > i && route.nodes.slice(0, i + 1).join("\0") === rootNodes.join("\0")) {
          banned.add(route.edges[i].id);
        }
      }
      const spurRequest = { ...request, source: spurNode };
      const spur = shortestPath(edges, spurRequest, banned, new Set(rootNodes.slice(0, -1)));
      if (!spur) continue;
      const combined: SearchRoute = {
        edges: [...rootEdges, ...spur.edges],
        nodes: [...rootNodes.slice(0, -1), ...spur.nodes],
        weight: rootEdges.reduce((sum, edge) => sum + edgeWeight(edge, request.metric), 0) + spur.weight,
      };
      const key = routeSignature(combined);
      if (!candidateKeys.has(key) && !accepted.some((route) => routeSignature(route) === key)) {
        candidates.push(combined);
        candidateKeys.add(key);
      }
    }
    candidates.sort((a, b) => a.weight - b.weight);
    const next = candidates.shift();
    if (!next) break;
    accepted.push(next);
  }
  return accepted;
}

function totals(route: SearchRoute, cargoWeight: number): Omit<RouteResult, "score"> {
  return {
    connectionIds: route.edges.map((edge) => edge.id),
    stops: route.nodes,
    modes: [...new Set(route.edges.map((edge) => edge.mode))],
    distanceKm: route.edges.reduce((sum, edge) => sum + edge.distanceKm, 0),
    cost: route.edges.reduce((sum, edge) => sum + edge.cost + edge.handlingCost, 0) * cargoWeight,
    timeHours: route.edges.reduce((sum, edge) => sum + edge.timeHours + edge.transferHours, 0),
  };
}

function greedyPath(edges: Connection[], request: RouteRequest): SearchRoute | undefined {
  const nodes = [request.source];
  const path: Connection[] = [];
  const visited = new Set(nodes);
  let current = request.source;
  while (current !== request.destination && path.length <= edges.length) {
    const next = edges.filter((edge) => edge.source === current && eligible(edge, request) && !visited.has(edge.destination))
      .sort((a, b) => edgeWeight(a, request.metric) - edgeWeight(b, request.metric))[0];
    if (!next) return undefined;
    path.push(next);
    current = next.destination;
    nodes.push(current);
    visited.add(current);
  }
  if (current !== request.destination) return undefined;
  return { edges: path, nodes, weight: path.reduce((sum, edge) => sum + edgeWeight(edge, request.metric), 0) };
}

function validateConnections(connections: Connection[]) {
  const ids = new Set<string>();
  for (const edge of connections) {
    if (!edge || typeof edge.id !== "string" || !edge.id || ids.has(edge.id) ||
      typeof edge.source !== "string" || !edge.source.trim() ||
      typeof edge.destination !== "string" || !edge.destination.trim() ||
      edge.source === edge.destination ||
      !["road", "rail", "air", "sea"].includes(edge.mode) ||
      ![edge.distanceKm, edge.cost, edge.timeHours, edge.capacityTons, edge.transferHours, edge.handlingCost].every(Number.isFinite) ||
      edge.distanceKm <= 0 || edge.cost < 0 || edge.timeHours <= 0 || edge.capacityTons <= 0 ||
      edge.transferHours < 0 || edge.handlingCost < 0 || typeof edge.available !== "boolean") {
      throw new Error("Connections contain invalid, duplicate or incomplete data.");
    }
    const coordinates = [edge.sourceLat, edge.sourceLon, edge.destinationLat, edge.destinationLon];
    if (coordinates.some((value) => value !== undefined) &&
      (!coordinates.every((value) => typeof value === "number" && Number.isFinite(value)) ||
        edge.sourceLat! < -90 || edge.sourceLat! > 90 || edge.destinationLat! < -90 || edge.destinationLat! > 90 ||
        edge.sourceLon! < -180 || edge.sourceLon! > 180 || edge.destinationLon! < -180 || edge.destinationLon! > 180)) {
      throw new Error("Connection coordinates must include valid latitude and longitude for both endpoints.");
    }
    if (edge.cargoTypes?.some((cargoType) => !["general", "perishable", "hazardous", "oversized", "bulk"].includes(cargoType))) {
      throw new Error("Connections contain an unsupported cargo type.");
    }
    ids.add(edge.id);
  }
}

export function optimizeRoutes(connections: Connection[], request: RouteRequest) {
  validateConnections(connections);
  if (!request.source.trim() || !request.destination.trim()) {
    throw new Error("Enter both a source and destination.");
  }
  if (request.source.trim().toLowerCase() === request.destination.trim().toLowerCase()) {
    throw new Error("Source and destination must be different.");
  }
  if (!Number.isFinite(request.cargoWeight) || request.cargoWeight <= 0) {
    throw new Error("Cargo weight must be greater than zero.");
  }
  if (!["cost", "distance", "time"].includes(request.metric)) {
    throw new Error("Select cost, distance or time as the optimization metric.");
  }
  if (!["general", "perishable", "hazardous", "oversized", "bulk"].includes(request.cargoType)) {
    throw new Error("Select a valid cargo type.");
  }
  const totalPriority = request.priorities.cost + request.priorities.time + request.priorities.distance;
  if (Math.abs(totalPriority - 100) > 0.01) {
    throw new Error("Cost, time and distance priorities must total 100%.");
  }
  if (!Number.isFinite(request.priorities.cost) || !Number.isFinite(request.priorities.time) ||
    !Number.isFinite(request.priorities.distance) ||
    [request.priorities.cost, request.priorities.time, request.priorities.distance].some((value) => value < 0)) {
    throw new Error("Optimization priorities must be non-negative percentages.");
  }
  if (!Array.isArray(request.modes) || !request.modes.length ||
    !request.modes.every((mode) => ["road", "rail", "air", "sea"].includes(mode))) {
    throw new Error("Select at least one valid transportation mode.");
  }
  if (!Number.isInteger(request.alternatives) || request.alternatives < 1 || request.alternatives > 8) {
    throw new Error("Alternative count must be between 1 and 8.");
  }
  if ((request.maxBudget !== undefined && (!Number.isFinite(request.maxBudget) || request.maxBudget < 0)) ||
    (request.maxHours !== undefined && (!Number.isFinite(request.maxHours) || request.maxHours < 0))) {
    throw new Error("Budget and delivery limits must be non-negative numbers.");
  }

  const filtered = connections.filter((edge) => eligible(edge, request));
  const candidates = yenKShortest(filtered, request, Math.min(8, Math.max(request.alternatives, request.alternatives * 2)));
  const greedy = greedyPath(filtered, request);
  if (greedy && !candidates.some((route) => routeSignature(route) === routeSignature(greedy))) candidates.push(greedy);
  if (!candidates.length) {
    const nodesWithAvailableCapacity = connections.filter((edge) =>
      edge.available && edge.capacityTons >= request.cargoWeight && request.modes.includes(edge.mode),
    );
    const explanation = nodesWithAvailableCapacity.length
      ? "No connected route satisfies the selected modes and cargo constraints."
      : "No available connection has enough capacity for this shipment. Add or enable a suitable connection.";
    return { routes: [], exploredEdges: filtered.length, explanation };
  }

  const measures = candidates.map((route) => totals(route, request.cargoWeight));
  const minMax = (values: number[]) => {
    const min = Math.min(...values);
    const max = Math.max(...values);
    return values.map((value) => max === min ? 0 : (value - min) / (max - min));
  };
  const costs = minMax(measures.map((item) => item.cost));
  const times = minMax(measures.map((item) => item.timeHours));
  const distances = minMax(measures.map((item) => item.distanceKm));
  const scored = measures.map((item, index) => {
    const score = (costs[index] * request.priorities.cost +
      times[index] * request.priorities.time +
      distances[index] * request.priorities.distance) / 100;
    return { ...item, score };
  }).filter((route) =>
    (request.maxBudget === undefined || route.cost <= request.maxBudget) &&
    (request.maxHours === undefined || route.timeHours <= request.maxHours),
  );
  scored.sort((a, b) => a.score - b.score);
  const rankedRoutes = scored.slice(0, request.alternatives);
  return {
    routes: rankedRoutes,
    exploredEdges: filtered.length,
    explanation: rankedRoutes.length
      ? `Ranked ${rankedRoutes.length} feasible alternative${rankedRoutes.length === 1 ? "" : "s"} using Dijkstra, Yen's loop-free paths and a greedy heuristic; connection capacity was checked.`
      : "Routes were found, but all exceed your budget or delivery-time limits.",
  };
}

export function optimizeFlow(connections: Connection[], shipments: FlowShipment[], modes: Connection["mode"][]) {
  validateConnections(connections);
  if (!Array.isArray(shipments) || !shipments.length) throw new Error("Add at least one shipment to the batch.");
  if (!Array.isArray(modes) || !modes.length || !modes.every((mode) => ["road", "rail", "air", "sea"].includes(mode))) {
    throw new Error("Select at least one valid transportation mode.");
  }
  const source = shipments[0].source?.trim();
  const destination = shipments[0].destination?.trim();
  if (!source || !destination || source.toLowerCase() === destination.toLowerCase()) {
    throw new Error("Each shipment needs distinct source and destination nodes.");
  }
  if (shipments.some((shipment) =>
    !shipment.id || shipment.source.trim() !== source || shipment.destination.trim() !== destination ||
    !Number.isFinite(shipment.quantityTons) || shipment.quantityTons <= 0,
  )) {
    throw new Error("Shipments must have positive quantities and share the same origin and destination for a capacity-safe flow batch.");
  }
  const demand = shipments.reduce((sum, shipment) => sum + shipment.quantityTons, 0);
  const eligibleEdges = connections.filter((edge) => edge.available && modes.includes(edge.mode));
  const graph = new Map<string, ResidualEdge[]>();
  const addNode = (node: string) => { if (!graph.has(node)) graph.set(node, []); };
  const addEdge = (from: string, to: string, capacity: number, costPerTon: number, connectionId?: string) => {
    addNode(from); addNode(to);
    const forward: ResidualEdge = { to, reverseIndex: graph.get(to)!.length, capacity, costPerTon, connectionId, forward: true };
    const reverse: ResidualEdge = { to: from, reverseIndex: graph.get(from)!.length, capacity: 0, costPerTon: -costPerTon, connectionId, forward: false };
    graph.get(from)!.push(forward);
    graph.get(to)!.push(reverse);
  };
  for (const edge of eligibleEdges) {
    addEdge(edge.source, edge.destination, edge.capacityTons, edge.cost + edge.handlingCost, edge.id);
  }
  addNode(source); addNode(destination);

  const edgeFlow = new Map<string, number>();
  let deliveredTons = 0;
  let totalCost = 0;
  while (deliveredTons < demand - 1e-8) {
    const distances = new Map<string, number>([[source, 0]]);
    const previous = new Map<string, { from: string; edgeIndex: number }>();
    const nodes = [...graph.keys()];
    for (let pass = 0; pass < nodes.length - 1; pass += 1) {
      let changed = false;
      for (const from of nodes) {
        const distance = distances.get(from);
        if (distance === undefined) continue;
        const outgoing = graph.get(from)!;
        for (let index = 0; index < outgoing.length; index += 1) {
          const edge = outgoing[index];
          if (edge.capacity <= 1e-8) continue;
          const next = distance + edge.costPerTon;
          if (next < (distances.get(edge.to) ?? Infinity)) {
            distances.set(edge.to, next);
            previous.set(edge.to, { from, edgeIndex: index });
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    if (!distances.has(destination)) break;
    let amount = demand - deliveredTons;
    let node = destination;
    while (node !== source) {
      const step = previous.get(node);
      if (!step) { amount = 0; break; }
      amount = Math.min(amount, graph.get(step.from)![step.edgeIndex].capacity);
      node = step.from;
    }
    if (amount <= 1e-8) break;
    node = destination;
    while (node !== source) {
      const step = previous.get(node)!;
      const edge = graph.get(step.from)![step.edgeIndex];
      edge.capacity -= amount;
      graph.get(node)![edge.reverseIndex].capacity += amount;
      if (edge.connectionId) {
        edgeFlow.set(edge.connectionId, (edgeFlow.get(edge.connectionId) ?? 0) + (edge.forward ? amount : -amount));
      }
      node = step.from;
    }
    deliveredTons += amount;
    totalCost += amount * distances.get(destination)!;
  }

  return {
    requestedTons: demand,
    deliveredTons,
    remainingTons: Math.max(0, demand - deliveredTons),
    totalCost,
    complete: deliveredTons >= demand - 1e-8,
    shipmentCount: shipments.length,
    allocations: [...edgeFlow.entries()].filter(([, tons]) => tons > 1e-8).map(([connectionId, tons]) => ({ connectionId, tons })),
    explanation: deliveredTons >= demand - 1e-8
      ? `Delivered ${deliveredTons} tonnes across ${shipments.length} shipment${shipments.length === 1 ? "" : "s"} while respecting connection capacities.`
      : `Only ${deliveredTons} of ${demand} tonnes could be assigned; available connection capacity is insufficient.`,
  };
}
