import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATION = join(ROOT, "supabase", "migrations", "distribution", "20261013000001_distribution.sql");

test("S13: migration contract — @up/@down, documentation tables, RLS, stage column", async () => {
  const sql = await readFile(MIGRATION, "utf8");
  assert.match(sql, /-- @up/);
  assert.match(sql, /-- @down/);
  for (const table of ["pods.documentation_parts", "pods.documentation_versions"]) {
    assert.ok(sql.includes(`create table if not exists ${table}`), table);
    assert.ok(sql.includes(`drop table if exists ${table}`), `down: ${table}`);
  }
  assert.ok(sql.includes("documentation_version"));
  assert.match(sql, /row level security/);
  assert.match(sql, /pods\.documentation\.write/);
  // Unique version filename (tests/s15/migrations-unique covers the set;
  // assert the shape here too).
  assert.match(MIGRATION, /20261013000001_distribution\.sql$/);
  // No secret values in the migration.
  assert.ok(!/sk-live|secret-value|PRIVATE KEY/.test(sql));
});

test("S13 [db]: RLS isolation for distribution tables", async (t) => {
  if (!process.env.PODS_TEST_DB_URL) {
    t.skip("needs PODS_TEST_DB_URL");
    return;
  }
  assert.fail("PODS_TEST_DB_URL is set but live-database assertions are not wired in this pass.");
});
