import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import handler from "../api/[...route]";
import geocodeHandler from "../api/geocode";
import healthHandler from "../api/health";

test("the Vercel catch-all exports a working JSON API handler", async () => {
  const server = createServer(handler).listen(0);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const health = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", service: "logihelp-api" });

    const response = await fetch(`http://127.0.0.1:${address.port}/api/optimize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connections: [],
        request: {
          source: "Chennai",
          destination: "Bengaluru",
          cargoWeight: 10,
          cargoType: "general",
          modes: ["road"],
          metric: "cost",
          priorities: { cost: 50, time: 30, distance: 20 },
          alternatives: 4,
        },
      }),
    });
    assert.equal(response.status, 200);
    const result = await response.json() as { routes: unknown[]; explanation: string };
    assert.deepEqual(result.routes, []);
    assert.match(result.explanation, /No available connection/);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = new URL(input instanceof Request ? input.url : input.toString());
      if (requestUrl.hostname === "127.0.0.1") return originalFetch(input, init);
      assert.equal(requestUrl.hostname, "photon.komoot.io");
      return new Response(JSON.stringify({
        features: [{
          geometry: { coordinates: [80.28, 13.08] },
          properties: { osm_id: 1, name: "Chennai", state: "Tamil Nadu", country: "India", osm_value: "city" },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    try {
      const placesResponse = await fetch(`http://127.0.0.1:${address.port}/api/geocode?q=Chennai`);
      assert.equal(placesResponse.status, 200);
      assert.deepEqual(await placesResponse.json(), [{
        id: "photon-1",
        label: "Chennai, Tamil Nadu, India",
        lon: 80.28,
        lat: 13.08,
        type: "city",
      }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("the dedicated Vercel health function returns JSON", async () => {
  const server = createServer(healthHandler).listen(0);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", service: "logihelp-api" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("the dedicated Vercel geocode function returns JSON place results", async () => {
  const originalFetch = globalThis.fetch;
  const server = createServer(geocodeHandler).listen(0);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = new URL(input instanceof Request ? input.url : input.toString());
    if (requestUrl.hostname === "127.0.0.1") return originalFetch(input, init);
    assert.equal(requestUrl.hostname, "photon.komoot.io");
    return new Response(JSON.stringify({
      features: [{
        geometry: { coordinates: [80.28, 13.08] },
        properties: { osm_id: 1, name: "Chennai", state: "Tamil Nadu", country: "India", osm_value: "city" },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/geocode?q=Chennai`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{
      id: "photon-1",
      label: "Chennai, Tamil Nadu, India",
      lon: 80.28,
      lat: 13.08,
      type: "city",
    }]);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
