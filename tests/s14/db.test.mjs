import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATION = join(ROOT, "supabase", "migrations", "admin", "20261010000001_admin.sql");

test("S14: migration contract — @up/@down, six tables, RLS, no secret plaintext", async () => {
  const sql = await readFile(MIGRATION, "utf8");
  assert.match(sql, /-- @up/);
  assert.match(sql, /-- @down/);
  for (const table of ["pods.access_tokens", "pods.idempotency_keys", "pods.tags", "pods.stacks", "pods.event_subscriptions", "pods.event_deliveries"]) {
    assert.ok(sql.includes(`create table if not exists ${table}`), table);
    assert.ok(sql.includes(`drop table if exists ${table}`), `down: ${table}`);
  }
  assert.match(sql, /row level security/);
  assert.match(sql, /pods\.token\.write/);
  // No secret values in the migration.
  assert.ok(!/sk-live|secret-value|PRIVATE KEY/.test(sql));
});

test("S14 [db]: RLS isolation for admin tables", async (t) => {
  if (!process.env.PODS_TEST_DB_URL) {
    t.skip("needs PODS_TEST_DB_URL");
    return;
  }
  assert.fail("PODS_TEST_DB_URL is set but live-database assertions are not wired in this pass.");
});
