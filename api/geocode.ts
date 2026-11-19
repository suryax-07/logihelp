import type { IncomingMessage, ServerResponse } from "node:http";
import { geocode } from "../server/geocoding.js";

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "Method not allowed." }));
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const result = await geocode(url.searchParams.get("q")?.trim() ?? "");
    res.statusCode = result.status;
    res.end(JSON.stringify(result.body));
  } catch (error) {
    console.error("LogiHelp geocoding function failed:", error);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "Location search failed unexpectedly." }));
  }
}
