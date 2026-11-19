import assert from "node:assert/strict";
import test from "node:test";
import type { Connection, RouteRequest } from "../shared/types";
import { optimizeFlow, optimizeRoutes } from "./algorithms";

const connections: Connection[] = [
  { id: "ab", source: "A", destination: "B", mode: "road", distanceKm: 10, cost: 2, timeHours: 2, capacityTons: 100, available: true, transferHours: 0, handlingCost: 0, sourceType: "manual", updatedAt: "2026-01-01" },
  { id: "bd", source: "B", destination: "D", mode: "rail", distanceKm: 20, cost: 3, timeHours: 5, capacityTons: 100, available: true, transferHours: 1, handlingCost: 0.5, sourceType: "manual", updatedAt: "2026-01-01" },
  { id: "ac", source: "A", destination: "C", mode: "road", distanceKm: 12, cost: 3, timeHours: 3, capacityTons: 100, available: true, transferHours: 0, handlingCost: 0, sourceType: "manual", updatedAt: "2026-01-01" },
  { id: "cd", source: "C", destination: "D", mode: "road", distanceKm: 11, cost: 2, timeHours: 4, capacityTons: 100, available: true, transferHours: 0, handlingCost: 0, sourceType: "manual", updatedAt: "2026-01-01" },
  { id: "bc", source: "B", destination: "C", mode: "rail", distanceKm: 1, cost: 0.2, timeHours: 1, capacityTons: 100, available: true, transferHours: 0, handlingCost: 0, sourceType: "manual", updatedAt: "2026-01-01" },
];

const request: RouteRequest = {
  source: "A",
  destination: "D",
  cargoWeight: 2,
  cargoType: "general",
  modes: ["road", "rail"],
  metric: "cost",
  priorities: { cost: 100, time: 0, distance: 0 },
  alternatives: 4,
};

test("returns distinct loop-free alternatives ranked by weighted cost", () => {
  const result = optimizeRoutes(connections, request);
  assert.ok(result.routes.length >= 2);
  assert.equal(result.routes[0].cost, 8.4);
  for (const route of result.routes) {
    assert.equal(new Set(route.stops).size, route.stops.length);
    assert.equal(route.stops[0], "A");
    assert.equal(route.stops.at(-1), "D");
  }
});

test("rejects unavailable, under-capacity and cargo-incompatible edges", () => {
  const limited = connections.map((edge) => ({
    ...edge,
    capacityTons: 1,
    cargoTypes: ["bulk"] as Connection["cargoTypes"],
  }));
  const result = optimizeRoutes(limited, request);
  assert.deepEqual(result.routes, []);
  assert.match(result.explanation, /capacity/i);
});

test("filters routes that violate the budget", () => {
  const result = optimizeRoutes(connections, { ...request, maxBudget: 1 });
  assert.deepEqual(result.routes, []);
  assert.match(result.explanation, /budget/i);
});

test("min-cost flow shares edge capacity across a shipment batch", () => {
  const flowEdges: Connection[] = [
    { ...connections[0], id: "ab", source: "A", destination: "B", cost: 1, capacityTons: 5 },
    { ...connections[1], id: "bd", source: "B", destination: "D", cost: 1, capacityTons: 8 },
    { ...connections[2], id: "ac", source: "A", destination: "C", cost: 2, capacityTons: 5 },
    { ...connections[3], id: "cd", source: "C", destination: "D", cost: 2, capacityTons: 8 },
  ];
  const result = optimizeFlow(flowEdges, [
    { id: "shipment-1", source: "A", destination: "D", quantityTons: 8 },
    { id: "shipment-2", source: "A", destination: "D", quantityTons: 2 },
  ], ["road", "rail"]);
  assert.equal(result.complete, true);
  assert.equal(result.deliveredTons, 10);
  assert.equal(result.totalCost, 32.5);
  assert.equal(result.allocations.find((item) => item.connectionId === "ab")?.tons, 5);
  assert.equal(result.allocations.find((item) => item.connectionId === "ac")?.tons, 5);
});

test("reports partial flow when total capacity is insufficient", () => {
  const result = optimizeFlow([{ ...connections[0], id: "ab", destination: "D", capacityTons: 4 }], [
    { id: "shipment-1", source: "A", destination: "D", quantityTons: 6 },
  ], ["road"]);
  assert.equal(result.complete, false);
  assert.equal(result.deliveredTons, 4);
  assert.equal(result.remainingTons, 2);
});

test("optimizes a 24,000-edge path without quadratic node scans or redundant spur searches", () => {
  const largeNetwork = Array.from({ length: 24_000 }, (_, index): Connection => ({
    id: `edge-${index}`,
    source: `Hub ${index}`,
    destination: `Hub ${index + 1}`,
    mode: "road",
    distanceKm: 10,
    cost: 5,
    timeHours: 2,
    capacityTons: 100,
    available: true,
    transferHours: 0,
    handlingCost: 0,
    sourceType: "manual",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));

  const result = optimizeRoutes(largeNetwork, {
    ...request,
    source: "Hub 0",
    destination: "Hub 24000",
  });

  assert.equal(result.routes.length, 1);
  assert.equal(result.routes[0].connectionIds.length, 24_000);
  assert.equal(result.routes[0].stops[0], "Hub 0");
  assert.equal(result.routes[0].stops.at(-1), "Hub 24000");
});

test("allocates a 24,000-edge flow path with a heap-based shortest-path search", () => {
  const largeNetwork = Array.from({ length: 24_000 }, (_, index): Connection => ({
    id: `flow-edge-${index}`,
    source: `Flow hub ${index}`,
    destination: `Flow hub ${index + 1}`,
    mode: "road",
    distanceKm: 10,
    cost: 5,
    timeHours: 2,
    capacityTons: 100,
    available: true,
    transferHours: 0,
    handlingCost: 0,
    sourceType: "manual",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
  const shipments = [{
    id: "batch-1",
    source: "Flow hub 0",
    destination: "Flow hub 24000",
    quantityTons: 2,
  }];

  const result = optimizeFlow(largeNetwork, shipments, ["road"]);

  assert.equal(result.complete, true);
  assert.equal(result.deliveredTons, 2);
  assert.equal(result.allocations.length, 24_000);
  assert.equal(result.totalCost, 240_000);
});
