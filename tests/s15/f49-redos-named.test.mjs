/**
 * F49 (S15 part 2): named-group ReDoS residual.
 *
 * `validateSafePattern` already rejects backreferences, lookaround and
 * nested quantifiers. Named capture groups (`(?<name>…)`) slipped through
 * the lookaround detector (only `(?=`, `(?!`, `(?<=`, `(?<!` were
 * flagged). They are now rejected explicitly; the 512-char + 100 KB caps
 * stay as defense in depth.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { compileSafePattern, validateSafePattern } from "../../lib/gateway/core/redos.mjs";

test("F49: named capture groups are rejected as non-linear", () => {
  for (const pattern of ["(?<year>\\d{4})-\\d{2}", "(?<name>a+)+", "(?P<name>\\w+)"]) {
    const problem = validateSafePattern(pattern);
    assert.ok(problem, `expected ${pattern} to be rejected, got null`);
    try {
      compileSafePattern(pattern);
      assert.fail(`expected ${pattern} to throw`);
    } catch (error) {
      assert.equal(error?.code, "REDOS_UNSAFE_PATTERN");
    }
  }
  // Ordinary groups still pass.
  assert.equal(validateSafePattern("(?:abc|def)"), null);
  assert.equal(validateSafePattern("(abc)"), null);
  assert.equal(validateSafePattern("a+b"), null);
});
