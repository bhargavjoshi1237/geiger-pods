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
  assert.ok(all.includes("pods.logs.view"), "logs read policy is missing");
  assert.ok(all.includes("pods.alarm.write"), "alarm write policy is missing");
  assert.ok(all.includes("pods.export.write"), "export write policy is missing");
  assert.ok(all.includes("enable row level security"), "RLS is missing");
  assert.ok(all.includes("period_sec > 0 and period_sec % 60 = 0"), "alarm period guard is missing");
  assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(all), "a private key shipped in a migration");
});
