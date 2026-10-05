import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "supabase", "migrations", "processing");
const files = readdirSync(DIR).filter((name) => name.endsWith(".sql")).sort();

test("S06: processing migrations follow the geiger-orm file contract", () => {
  assert.ok(files.length >= 1, `expected at least 1 processing migration, saw ${files.length}`);
  let previous = "";
  for (const name of files) {
    assert.match(name, /^\d{14}_[a-z0-9_]+\.sql$/, `bad migration filename ${name}`);
    const stamp = name.slice(0, 14);
    // S06 runs in parallel with S03/S04: its stamp must sort after the S02
    // foundation (20261006000105) and be at least 2h past the 2026-10-04
    // assignment date, so deploy ordering stays deterministic.
    assert.ok(stamp > "20261006000105", `migration ${name} must sort after the S02 foundation`);
    assert.ok(stamp > previous, `migration ${name} is out of timestamp order`);
    previous = stamp;
    const body = readFileSync(join(DIR, name), "utf8");
    assert.ok(body.includes("-- @up"), `${name} is missing -- @up`);
    assert.ok(body.includes("-- @down"), `${name} is missing -- @down (rollback must exist)`);
    assert.ok(!/using\s*\(\s*true\s*\)/i.test(body), `${name} still contains a demo using (true) policy`);
  }
});

test("S06: processing migrations create the four tables with RLS and no secrets", () => {
  const all = files.map((name) => readFileSync(join(DIR, name), "utf8")).join("\n");
  for (const table of ["pods.models", "pods.request_validators", "pods.method_responses", "pods.gateway_responses"]) {
    assert.ok(all.includes(table), `${table} is missing`);
  }
  assert.ok(all.includes("unique (api_id, name)"), "models unique(api_id, name) is missing");
  assert.ok(all.includes("unique (method_id, status_code)"), "method_responses unique(method_id, status_code) is missing");
  assert.ok(all.includes("unique (api_id, response_type)"), "gateway_responses unique(api_id, response_type) is missing");
  assert.ok(all.includes("pods.model.write"), "model write policy is missing");
  assert.ok(all.includes("pods.route.write"), "route write policy is missing");
  assert.ok(all.includes("pods.gateway_response.write"), "gateway_response write policy is missing");
  assert.ok(all.includes("enable row level security"), "RLS is missing");
  assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(all), "a private key shipped in a migration");
});
