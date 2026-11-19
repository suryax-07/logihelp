import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import handler from "../api/[...route]";

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
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
