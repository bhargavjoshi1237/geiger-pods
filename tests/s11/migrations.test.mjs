/**
 * S11 migration test: domains + WAF tables with @up/@down and S02-style RLS.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = join(ROOT, "supabase", "migrations", "domains");

test("S11: domains migration has @up/@down, the spec tables and RLS", async () => {
  const files = (await readdir(DIR)).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(files.length >= 1, "expected at least one domains migration");
  // 14-digit versions, unique and later than all existing migrations.
  const versions = files.map((name) => name.slice(0, 14));
  for (const version of versions) {
    assert.match(version, /^[0-9]{14}$/, version);
    assert.ok(version > "20261016000001", `${version} must be later than existing migrations`);
  }
  assert.equal(new Set(versions).size, versions.length, "migration versions must be unique");

  const sql = (await Promise.all(files.map((name) => readFile(join(DIR, name), "utf8")))).join("\n");
  assert.match(sql, /-- @up/);
  assert.match(sql, /-- @down/);
  for (const table of [
    "domain_names", "api_mappings", "routing_rules", "trust_stores",
    "domain_access_associations", "ip_sets", "regex_sets", "web_acls", "web_acl_associations",
  ]) {
    assert.match(sql, new RegExp(`create table if not exists pods\\.${table}`), table);
    assert.match(sql, new RegExp(`drop table if exists pods\\.${table}`), `${table} rollback`);
  }
  assert.match(sql, /unique \(domain_id, base_path\)/);
  assert.match(sql, /pods\.domain\.write/);
  assert.match(sql, /pods\.trust_store\.write/);
  assert.match(sql, /pods\.waf\.write/);
  assert.match(sql, /enable row level security/);
});

test("S11 [db]: domain and WAF RLS mirror S02 patterns", async (t) => {
  if (!process.env.PODS_TEST_DB_URL) {
    t.skip("needs PODS_TEST_DB_URL (same gate as earlier specs)");
    return;
  }
  const { readFile } = await import("node:fs/promises");
  const sql = await readFile(join(DIR, (await readdir(DIR)).filter((name) => name.endsWith(".sql")).sort()[0]), "utf8");
  assert.match(sql, /pods\.can\('pods\.domain\.write'/);
  assert.match(sql, /pods\.can\('pods\.waf\.write'/);
});
