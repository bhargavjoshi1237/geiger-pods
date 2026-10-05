import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "supabase", "migrations", "catalog");
const files = readdirSync(DIR).filter((name) => name.endsWith(".sql")).sort();

test("S03: catalog migrations follow the geiger-orm file contract", () => {
  assert.ok(files.length >= 1, `expected at least 1 catalog migration, saw ${files.length}`);
  let previous = "";
  for (const name of files) {
    assert.match(name, /^\d{14}_[a-z0-9_]+\.sql$/, `bad migration filename ${name}`);
    const stamp = name.slice(0, 14);
    assert.ok(stamp > previous, `migration ${name} is out of timestamp order`);
    previous = stamp;
    const body = readFileSync(join(DIR, name), "utf8");
    assert.ok(body.includes("-- @up"), `${name} is missing -- @up`);
    assert.ok(body.includes("-- @down"), `${name} is missing -- @down (rollback must exist)`);
    assert.ok(!/using\s*\(\s*true\s*\)/i.test(body), `${name} still contains a demo using (true) policy`);
  }
});

test("S03: catalog migration creates the API tables with RLS and draft invariants", () => {
  const all = files.map((name) => readFileSync(join(DIR, name), "utf8")).join("\n");
  for (const table of ["pods.apis", "pods.rest_resources", "pods.rest_methods", "pods.http_routes"]) {
    assert.ok(all.includes(table), `${table} is missing from the catalog migration`);
  }
  assert.ok(all.includes("pods.api.create"), "api create policy is missing");
  assert.ok(all.includes("pods.api.update"), "api update policy is missing");
  assert.ok(all.includes("pods.api.delete"), "api delete policy is missing");
  assert.ok(all.includes("pods.route.write"), "route write policy is missing");
  assert.ok(all.includes("rest_resource_path"), "resource path trigger is missing");
  assert.ok(all.includes("enable row level security"), "RLS is not enabled");
  // Unique draft invariants among non-deleted rows.
  assert.ok(all.includes("(project_id, name)"), "per-project API name uniqueness is missing");
  assert.ok(all.includes("(api_id, path)"), "per-API resource path uniqueness is missing");
  assert.ok(all.includes("(resource_id, http_method)"), "per-resource method uniqueness is missing");
  assert.ok(all.includes("(api_id, route_key)"), "per-API route key uniqueness is missing");
  // No example credentials may ship in a migration.
  assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(all), "a private key shipped in a migration");
});
