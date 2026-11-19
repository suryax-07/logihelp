import assert from "node:assert/strict";
import test from "node:test";
import { parseConnectionCsv } from "../src/connection-import";

const header = "source,destination,mode,distanceKm,cost,timeHours,capacityTons,sourceLat,sourceLon,destinationLat,destinationLon,available,cargoTypes";

test("imports 24,000 CSV connections without building a full intermediate row matrix", () => {
  const rows = [header];
  for (let index = 0; index < 24_000; index += 1) {
    rows.push(`Origin ${index},Destination ${index},road,10,5,2,100,13,80,14,81,true,general`);
  }

  const imported = parseConnectionCsv(rows.join("\n"), []);

  assert.equal(imported.connections.length, 24_000);
  assert.equal(imported.duplicateCount, 0);
  assert.equal(imported.connections[0].source, "Origin 0");
  assert.equal(imported.connections[23_999].destination, "Destination 23999");
});

test("parses quoted CSV fields and skips duplicates already in storage", () => {
  const existing = [{
    id: "saved",
    source: "Origin, East",
    destination: "Destination \"A\"",
    mode: "road",
  }] as Parameters<typeof parseConnectionCsv>[1];
  const csv = [
    header,
    '"Origin, East","Destination ""A""",road,10,5,2,100,13,80,14,81,true,general',
    "Origin B,Destination B,rail,20,7,3,200,15,82,16,83,false,bulk",
  ].join("\r\n");

  const imported = parseConnectionCsv(csv, existing);

  assert.equal(imported.connections.length, 1);
  assert.equal(imported.connections[0].source, "Origin B");
  assert.equal(imported.connections[0].available, false);
  assert.deepEqual(imported.connections[0].cargoTypes, ["bulk"]);
  assert.equal(imported.duplicateCount, 1);
});

test("rejects malformed or invalid CSV rows with their source row number", () => {
  assert.throws(() => parseConnectionCsv(`${header}\nOrigin,Destination,road,0,1,1,1,0,0,1,1`, []), /spreadsheet row 2/);
  assert.throws(() => parseConnectionCsv(`${header}\n"unclosed`, []), /unclosed quoted field/);
});
