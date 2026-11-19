import type { CargoType, Connection, TransportMode } from "../shared/types";

const modes: TransportMode[] = ["road", "rail", "air", "sea"];
const cargoTypes: CargoType[] = ["general", "perishable", "hazardous", "oversized", "bulk"];
const requiredHeaders = [
  "source", "destination", "mode", "distancekm", "cost", "timehours",
  "capacitytons", "sourcelat", "sourcelon", "destinationlat", "destinationlon",
];

export function parseConnectionCsv(text: string, existing: Connection[]) {
  const rows: Connection[] = [];
  const keys = new Set(existing.map((edge) => connectionKey(edge)));
  let duplicateCount = 0;
  let headers: string[] | undefined;
  let headerIndexes: Map<string, number> | undefined;
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let rowNumber = 0;
  const importedAt = new Date().toISOString();

  const finishRow = () => {
    row.push(field.trim());
    field = "";
    if (!row.some((cell) => cell)) {
      row = [];
      return;
    }

    rowNumber += 1;
    if (!headers) {
      headers = row.map((value) => value.toLowerCase());
      const headerSet = new Set(headers);
      const missing = requiredHeaders.filter((header) => !headerSet.has(header));
      if (missing.length) throw new Error(`Spreadsheet headers must include: ${requiredHeaders.join(", ")}.`);
      headerIndexes = new Map(headers.map((header, index) => [header, index]));
      row = [];
      return;
    }

    const get = (name: string) => row[headerIndexes!.get(name) ?? -1] ?? "";
    const source = get("source");
    const destination = get("destination");
    const mode = get("mode").toLowerCase() as TransportMode;
    const numeric = ["distancekm", "cost", "timehours", "capacitytons", "sourcelat", "sourcelon", "destinationlat", "destinationlon"]
      .map((name) => Number(get(name)));
    const cargoValue = get("cargotypes");
    const cargo = cargoValue ? cargoValue.split("|").map((value) => value.trim().toLowerCase()) as CargoType[] : [];
    if (!modes.includes(mode) ||
      [numeric[0], numeric[2], numeric[3]].some((value) => !Number.isFinite(value) || value <= 0) ||
      !Number.isFinite(numeric[1]) || numeric[1] < 0 ||
      numeric.slice(4).some((value) => !Number.isFinite(value)) ||
      !source || !destination || source.toLowerCase() === destination.toLowerCase() ||
      ["sourcelat", "sourcelon", "destinationlat", "destinationlon"].some((name) => !get(name)) ||
      numeric[4] < -90 || numeric[4] > 90 || numeric[6] < -90 || numeric[6] > 90 ||
      numeric[5] < -180 || numeric[5] > 180 || numeric[7] < -180 || numeric[7] > 180 ||
      cargo.some((type) => !cargoTypes.includes(type))) {
      throw new Error(`Invalid connection on spreadsheet row ${rowNumber}.`);
    }

    const connection: Connection = {
      id: crypto.randomUUID(),
      source,
      destination,
      mode,
      distanceKm: numeric[0],
      cost: numeric[1],
      timeHours: numeric[2],
      capacityTons: numeric[3],
      available: get("available").toLowerCase() !== "false",
      transferHours: 0,
      handlingCost: 0,
      sourceType: "manual",
      updatedAt: importedAt,
      sourceLat: numeric[4],
      sourceLon: numeric[5],
      destinationLat: numeric[6],
      destinationLon: numeric[7],
      cargoTypes: cargo,
    };
    const key = connectionKey(connection);
    if (keys.has(key)) duplicateCount += 1;
    else {
      keys.add(key);
      rows.push(connection);
    }
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' && quoted && text[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(field.trim());
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      finishRow();
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("CSV contains an unclosed quoted field.");
  if (field || row.length) finishRow();
  if (!headers || !rows.length && duplicateCount === 0) {
    throw new Error("CSV must include a header and at least one connection.");
  }
  return { connections: rows, duplicateCount };
}

function connectionKey(connection: Pick<Connection, "mode" | "source" | "destination">) {
  return `${connection.mode}:${connection.source.toLowerCase()}:${connection.destination.toLowerCase()}`;
}
