/**
 * S11A acceptance: routing-rule glob/condition table (AWS examples).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRoutingRules, matchHeaderGlob } from "../../lib/gateway/core/edge/routing-rules.mjs";

function rule(id, priority, conditions, stripBasePath = false) {
  return {
    id,
    priority,
    conditions,
    action: { invokeApi: { apiId: `api-${id}`, stage: "prod", stripBasePath } },
  };
}

test("S11A: routing rules AWS examples — header globs *a, a*, *a*, two headers AND, base path strip true/false table — all rows pass", async () => {
  // Glob shapes: `*x` suffix, `x*` prefix, `*x*` infix, exact.
  assert.equal(matchHeaderGlob("*a", "pizza"), true);
  assert.equal(matchHeaderGlob("*a", "pizzb"), false);
  assert.equal(matchHeaderGlob("a*", "apple"), true);
  assert.equal(matchHeaderGlob("a*", "crab"), false);
  assert.equal(matchHeaderGlob("*a*", "crabapple"), true);
  assert.equal(matchHeaderGlob("*a*", "xyz"), false);
  assert.equal(matchHeaderGlob("exact", "exact"), true);
  assert.equal(matchHeaderGlob("exact", "Exact"), false);
  assert.equal(matchHeaderGlob("*", "anything"), true);
  // Case-sensitive values; interior stars are invalid.
  assert.equal(matchHeaderGlob("Exact", "exact"), false);
  assert.throws(() => matchHeaderGlob("a*b", "ab"), /glob/i);

  // Header names match case-insensitively.
  const headerRule = rule("h", 1, { matchHeaders: [{ header: "X-Version", valueGlob: "v2*" }] });
  const byLower = evaluateRoutingRules([headerRule], { headers: { "x-version": "v2x" }, path: "/pets" });
  assert.equal(byLower?.id, "h");
  const byUpper = evaluateRoutingRules([headerRule], {
    headers: {},
    rawHeaders: [["X-VERSION", "v2x"]],
    path: "/pets",
  });
  assert.equal(byUpper?.id, "h");

  // Two headers AND: both must hold.
  const andRule = rule("and", 1, {
    matchHeaders: [
      { header: "x-a", valueGlob: "1*" },
      { header: "x-b", valueGlob: "*2" },
    ],
  });
  assert.equal(evaluateRoutingRules([andRule], { headers: { "x-a": "10", "x-b": "02" }, path: "/" })?.id, "and");
  assert.equal(evaluateRoutingRules([andRule], { headers: { "x-a": "10", "x-b": "03" }, path: "/" }), null);
  assert.equal(evaluateRoutingRules([andRule], { headers: { "x-a": "10" }, path: "/" }), null);

  // Base path condition: prefix at segment boundaries, case-sensitive.
  const baseRule = rule("base", 1, { matchBasePaths: ["v2"] }, true);
  const hit = evaluateRoutingRules([baseRule], { headers: {}, path: "/v2/pets" });
  assert.equal(hit?.id, "base");
  assert.equal(evaluateRoutingRules([baseRule], { headers: {}, path: "/v2x/pets" }), null);
  assert.equal(evaluateRoutingRules([baseRule], { headers: {}, path: "/V2/pets" }), null);
  assert.equal(evaluateRoutingRules([baseRule], { headers: {}, path: "/v2" })?.id, "base");

  // Priority order: lowest number wins.
  const low = rule("low", 5, { matchHeaders: [{ header: "x-a", valueGlob: "*" }] });
  const high = rule("high", 50, { matchHeaders: [{ header: "x-a", valueGlob: "*" }] });
  assert.equal(evaluateRoutingRules([high, low], { headers: { "x-a": "1" }, path: "/" })?.id, "low");

  // No rule matches → null (the caller falls back or 404s by routing mode).
  assert.equal(evaluateRoutingRules([headerRule], { headers: {}, path: "/" }), null);
});
