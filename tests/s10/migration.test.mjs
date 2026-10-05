/**
 * S10: observability migration has @up/@down and the expected tables;
 * retention job drops partitions older than log_retention_days (pure helper).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { partitionsToDrop } from "../../lib/control/logs.mjs";

const MIGRATION_DIR = join(import.meta.dirname, "..", "..", "supabase", "migrations", "observability");

describe("S10: retention job drops partitions older than log_retention_days", () => {
  it("lists only partitions strictly older than the cutoff", () => {
    const dropped = partitionsToDrop({
      partitions: ["access_logs_2026_09_01", "access_logs_2026_09_19", "access_logs_2026_09_20", "access_logs_2026_10_04"],
      tableFor: (name) => name,
      todayUtc: "2026-10-05",
      retentionDays: 15,
    });
    assert.deepEqual(dropped, ["access_logs_2026_09_01", "access_logs_2026_09_19"]);
  });
});

describe("S10: observability migration", () => {
  it("has @up/@down and the expected tables", () => {
    const files = readdirSync(MIGRATION_DIR).filter((name) => name.endsWith(".sql"));
    assert.ok(files.length >= 1, "at least one observability migration");
    for (const file of files) {
      const sql = readFileSync(join(MIGRATION_DIR, file), "utf8");
      assert.match(sql, /@up/, `${file} needs @up`);
      assert.match(sql, /@down/, `${file} needs @down`);
    }
    const combined = files.map((file) => readFileSync(join(MIGRATION_DIR, file), "utf8")).join("\n");
    for (const table of [
      "metrics_minute", "metrics_hour", "access_logs", "execution_logs",
      "trace_spans", "alarms", "notification_channels", "alarm_history",
      "log_sinks", "sampling_rules",
    ]) {
      assert.match(combined, new RegExp(table), `missing table ${table}`);
    }
    assert.match(combined, /on conflict/i, "minute upsert must add on conflict");
    assert.match(combined, /log_retention_days|retention/i, "retention wiring documented");
  });
});
