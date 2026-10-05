import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "supabase", "migrations", "observability");
const files = readdirSync(DIR).filter((name) => name.endsWith(".sql")).sort();

test("S10: observability migrations follow the geiger-orm file contract", () => {
  assert.ok(files.length >= 1, `expected at least 1 observability migration, saw ${files.length}`);
  let previous = "";
  for (const name of files) {
    assert.match(name, /^\d{14}_[a-z0-9_]+\.sql$/, `bad migration filename ${name}`);
    const stamp = name.slice(0, 14);
    assert.ok(stamp > "20261006000105", `migration ${name} must sort after the S02 foundation`);
    assert.ok(stamp > previous, `migration ${name} is out of timestamp order`);
    previous = stamp;
    const body = readFileSync(join(DIR, name), "utf8");
    assert.ok(body.includes("-- @up"), `${name} is missing -- @up`);
    assert.ok(body.includes("-- @down"), `${name} is missing -- @down (rollback must exist)`);
    assert.ok(!/using\s*\(\s*true\s*\)/i.test(body), `${name} still contains a demo using (true) policy`);
  }
});

test("S10: observability migrations create the telemetry tables with RLS and no secrets", () => {
  const all = files.map((name) => readFileSync(join(DIR, name), "utf8")).join("\n");
  for (const table of [
    "pods.metrics_minute", "pods.metrics_hour", "pods.access_logs", "pods.execution_logs",
    "pods.trace_spans", "pods.log_sinks", "pods.alarms", "pods.alarm_history",
    "pods.notification_channels", "pods.sampling_rules",
  ]) {
    assert.ok(all.includes(table), `${table} is missing`);
  }
  assert.ok(all.includes("unique (project_id, api_id, stage, dims_hash, minute, metric)"), "metrics_minute upsert key is missing");
  // Permission keys must appear inside `create policy` statements (not just
  // in comments): reads gated on logs/monitoring view, data-trace on
  // logs.data, alarm writes on alarm.write, sink writes on export.write.
  const policies = [...all.matchAll(/create\s+policy\s+(\S+)\s+on\s+(\S+)([\s\S]*?);/gi)].map((m) => ({
    name: m[1],
    table: m[2],
    body: m[0],
  }));
  assert.ok(policies.length >= 8, `expected RLS policies, saw ${policies.length}`);
  const has = (table, perm) => policies.some((p) => p.table.includes(table) && p.body.includes(perm));
  for (const table of ["pods.metrics_minute", "pods.metrics_hour", "pods.access_logs", "pods.trace_spans"]) {
    assert.ok(
      has(table, "pods.logs.view") || has(table, "pods.monitoring.view"),
      `${table} read policy must gate on pods.logs.view or pods.monitoring.view via pods.can`,
    );
  }
  assert.ok(
    policies.some((p) => p.table.includes("pods.execution_logs") && p.body.includes("pods.logs.data")),
    "execution_logs policy must require pods.logs.data for data-trace rows",
  );
  assert.ok(has("pods.alarms", "pods.alarm.write"), "alarms write policy must require pods.alarm.write");
  assert.ok(has("pods.notification_channels", "pods.alarm.write"), "notification_channels write policy must require pods.alarm.write");
  assert.ok(has("pods.log_sinks", "pods.export.write"), "log_sinks write policy must require pods.export.write");
  assert.ok(has("pods.sampling_rules", "pods.export.write"), "sampling_rules write policy must require pods.export.write");
  // No membership-only fallback via role_grants: reads/writes go through pods.can/is_member.
  assert.ok(!/from\s+pods\.role_grants/i.test(all), "policies must use pods.can/is_member, not raw pods.role_grants");
  assert.ok(all.includes("enable row level security"), "RLS is missing");
  assert.ok(all.includes("period_sec > 0 and period_sec % 60 = 0"), "alarm period guard is missing");
  assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(all), "a private key shipped in a migration");
});
