import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("S08: usage migration has @up/@down, the spec tables and RLS", async () => {
  const sql = await readFile("supabase/migrations/usage/20261008000002_usage.sql", "utf8");
  assert.match(sql, /-- @up/);
  assert.match(sql, /-- @down/);
  for (const table of ["api_keys", "usage_plans", "usage_plan_stages", "usage_plan_keys", "usage_daily", "quota_adjustments"]) {
    assert.match(sql, new RegExp(`create table if not exists pods\\.${table}`), table);
    assert.match(sql, new RegExp(`drop table if exists pods\\.${table}`), `${table} rollback`);
  }
  assert.match(sql, /value_hmac bytea not null unique/);
  assert.match(sql, /pods\.api_key\.write/);
  assert.match(sql, /pods\.usage_plan\.write/);
  assert.match(sql, /pods\.usage\.view/);
  assert.match(sql, /enable row level security/);
});
