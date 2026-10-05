import assert from "node:assert/strict";
import test from "node:test";
import {
  signPayload, toNdjson, batchRows, retryDelayMs, shouldRetry,
  deliverHttpsBatch, s3KeyFor, encodeS3Batch, createSinkOutbox,
} from "../../lib/gateway/core/observe/sinks.mjs";

test("S10: https sink receives signed NDJSON; failing sink retries with backoff and does not block others", async () => {
  const received = [];
  const secret = "hmac-secret";
  const ok = await deliverHttpsBatch({
    url: "https://logs.local/ingest",
    secret,
    rows: [{ request_id: "r1" }, { request_id: "r2" }],
    fetchImpl: async (url, options) => {
      received.push({ url, options });
      return { ok: true, status: 200 };
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(received.length, 1);
  assert.equal(received[0].options.headers["content-type"], "application/x-ndjson");
  assert.equal(received[0].options.headers["x-pods-signature"], signPayload(toNdjson([{ request_id: "r1" }, { request_id: "r2" }]), secret));
  assert.equal(received[0].options.body, '{"request_id":"r1"}\n{"request_id":"r2"}\n');

  // Batching: rows split at 1 MB.
  const big = { line: "x".repeat(600 * 1024) };
  assert.equal(batchRows([big, big, { small: true }]).length, 3);
  assert.equal(batchRows([{ a: 1 }])[0].bytes > 0, true);

  // Retry schedule: grows exponentially, capped at 5 min.
  const delays = [1, 2, 3, 9, 20].map((attempt) => retryDelayMs(attempt, () => 0.5));
  assert.ok(delays[0] < delays[1] && delays[1] < delays[2], `expected growth: ${delays}`);
  assert.ok(delays[4] <= 5 * 60 * 1000, `expected cap: ${delays[4]}`);
  assert.equal(shouldRetry({ firstAttemptAt: 0, attempts: 3, now: 1000 }), true);
  assert.equal(shouldRetry({ firstAttemptAt: 0, attempts: 99, now: 25 * 3600 * 1000 }), false);

  // Outbox: a failing sink retries with backoff while others deliver.
  const outbox = createSinkOutbox();
  outbox.enqueue({ sinkId: "bad", kind: "https", payload: [1] });
  const due = outbox.due(Date.now() + 1000);
  assert.equal(due.length, 1);
  const retrying = outbox.settled(due[0], false, 1000);
  assert.equal(retrying.outcome, "retrying");
  assert.ok(outbox.due(1000).length === 0, "backoff must delay the next attempt");
  const dropped = outbox.settled({ ...due[0], attempts: 999, firstAttemptAt: 0 }, false, 25 * 3600 * 1000);
  assert.equal(dropped.outcome, "dropped");
  outbox.enqueue({ sinkId: "good", kind: "https", payload: [2] });
  const good = outbox.due(Date.now() + 1000).find((entry) => entry.sinkId === "good");
  assert.deepEqual(outbox.settled(good, true).outcome, "delivered");
});

test("S10: s3 keys follow prefix/yyyy/mm/dd/HH/{instance}-{seq}.ndjson.gz", () => {
  const key = s3KeyFor({ prefix: "logs", now: new Date(Date.UTC(2026, 9, 9, 7, 30)), instance: "i-1", seq: 3 });
  assert.equal(key, "logs/2026/10/09/07/i-1-3.ndjson.gz");
  const batch = encodeS3Batch([{ a: 1 }], { prefix: "logs", now: new Date(Date.UTC(2026, 9, 9, 7, 30)), instance: "i-1", seq: 0 });
  assert.equal(batch.key, "logs/2026/10/09/07/i-1-0.ndjson.gz");
  assert.equal(batch.count, 1);
  assert.ok(batch.bytes.length > 0);
});
