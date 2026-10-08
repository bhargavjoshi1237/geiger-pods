/**
 * S15 limits acceptance (spec §1): `limits.mjs` and `docs/limits.md` in sync;
 * each limit enforced (one test per row: N allowed, N+1 rejected).
 *
 * Sync is proven by re-rendering the doc (`renderLimitsDoc`) and comparing
 * byte-for-byte. Enforcement is proven per `LIMIT_TABLE` row via the pure
 * `exceedsCountLimit` checker (N allowed, N+1 rejected), plus spot checks
 * that the control plane and runtime use the same constants (documentation
 * parts, plans per key, method throttles, model bytes, resource policy,
 * request predicates).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LIMIT_TABLE,
  exceedsBodyLimit,
  exceedsCountLimit,
  exceedsHeaderLimit,
  exceedsUrlLimit,
  getLimit,
} from "../../lib/gateway/core/limits.mjs";
import { assertCountWithinLimit } from "../../lib/control/limits.mjs";
import { renderLimitsDoc } from "../../scripts/gen-limits-doc.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("S15: limits.mjs and docs/limits.md in sync; each limit enforced (one test per row: N allowed, N+1 rejected)", async () => {
  // 1. Doc sync.
  const rendered = await renderLimitsDoc();
  const onDisk = readFileSync(join(ROOT, "docs", "limits.md"), "utf8");
  assert.equal(onDisk, rendered, "docs/limits.md must be generated from limits.mjs (run node scripts/gen-limits-doc.mjs)");

  // 2. Per-row N / N+1 through the pure checker + control-plane thrower.
  assert.ok(LIMIT_TABLE.length >= 50, `expected the full §1 table, got ${LIMIT_TABLE.length} rows`);
  for (const entry of LIMIT_TABLE) {
    const limit = getLimit(entry.key);
    assert.equal(limit, entry.default, `${entry.key}: default mismatch`);
    assert.equal(exceedsCountLimit(entry.key, limit), false, `${entry.key}: N (${limit}) must be allowed`);
    assert.equal(exceedsCountLimit(entry.key, limit + 1), true, `${entry.key}: N+1 must be rejected`);
    // Control plane: N passes silently, N+1 throws limit_exceeded.
    assert.doesNotThrow(() => assertCountWithinLimit(entry.key, limit));
    assert.throws(
      () => assertCountWithinLimit(entry.key, limit + 1),
      (error) => error?.code === "limit_exceeded" && error?.status === 409,
      `${entry.key}: control plane must throw limit_exceeded`,
    );
    // Adjustable limits honor staff overrides; fixed ones ignore them.
    if (entry.adjustable) {
      assert.equal(getLimit(entry.key, { [entry.key]: limit + 5 }), limit + 5);
    } else {
      assert.equal(getLimit(entry.key, { [entry.key]: limit + 5 }), limit);
    }
  }

  // 3. Spot checks that existing services use the same constants.
  const documentation = await import("../../lib/control/documentation.mjs");
  assert.equal(documentation.MAX_PARTS_PER_API, getLimit("documentation_parts_per_api"));
  const apiKeys = await import("../../lib/control/api-keys.mjs");
  assert.equal(apiKeys.MAX_PLANS_PER_KEY, getLimit("plans_per_key"));
  const usagePlans = await import("../../lib/control/usage-plans.mjs");
  assert.equal(usagePlans.MAX_METHOD_THROTTLES, getLimit("method_throttles_per_plan_stage"));
  const validation = await import("../../lib/gateway/core/processing/validation.mjs");
  assert.equal(validation.MAX_API_SCHEMA_BYTES, getLimit("models_bytes_per_api"));
  const resourcePolicy = await import("../../lib/gateway/core/auth/resource-policy.mjs");
  assert.equal(resourcePolicy.MAX_RESOURCE_POLICY_CHARS, getLimit("resource_policy_chars"));

  // 4. Runtime predicates use the payload caps (S01 LIMITS stay compatible).
  const { LIMITS } = await import("../../lib/gateway/core/limits.mjs");
  assert.equal(exceedsBodyLimit(LIMITS.maxBodyBytes), false);
  assert.equal(exceedsBodyLimit(LIMITS.maxBodyBytes + 1), true);
  assert.equal(LIMITS.maxBodyBytes, getLimit("payload_bytes"));
  assert.equal(exceedsUrlLimit("x".repeat(LIMITS.maxUrlLengthChars)), false);
  assert.equal(exceedsUrlLimit(`x${"x".repeat(LIMITS.maxUrlLengthChars)}`), true);
  const headers = new Headers({ "x-test": "ok" });
  assert.equal(exceedsHeaderLimit(headers), false);
});
