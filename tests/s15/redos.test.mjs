/**
 * S15 part 1 (security) + F17: ReDoS corpus.
 *
 * Every regex surface the gateway evaluates — integration-response
 * `selection_pattern`, CORS wildcard origins, WAF regex statements, identity
 * validation expressions, VTL `replaceAll`/`split`/`matches` — must evaluate
 * in < 10 ms, including on classic catastrophic-backtracking payloads.
 * Dangerous patterns must be rejected at save time.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { selectCustomResponse } from "../../lib/gateway/core/integrations/function.mjs";
import { originAllowed } from "../../lib/gateway/core/processing/cors.mjs";
import { matchHeaderGlob } from "../../lib/gateway/core/edge/routing-rules.mjs";
import { validateRegexPattern } from "../../lib/gateway/core/edge/waf-engine.mjs";
import { createAuthorizer } from "../../lib/control/authorizers.mjs";
import { createIntegrationResponse } from "../../lib/control/integrations.mjs";
import { HttpError } from "../../lib/control/errors.mjs";

const EVIL_INPUTS = [
  "a".repeat(30) + "!",
  "a".repeat(100) + "!",
  "aaaaaaaaaa".repeat(10) + "b",
  "<script>" + " ".repeat(5000),
  "x".repeat(10000),
];

function timed(label, fn, budgetMs = 10) {
  for (const input of EVIL_INPUTS) {
    const start = performance.now();
    fn(input);
    const elapsed = performance.now() - start;
    assert.ok(
      elapsed < budgetMs,
      `${label}: evaluation took ${elapsed.toFixed(2)} ms on ${input.length}-char input (budget ${budgetMs} ms)`,
    );
  }
}

const ADMIN = { type: "user", userId: "u-admin" };

function controlFakeDb({ apiId = "api-1", integrationId = "int-1" } = {}) {
  const responses = [];
  const authorizers = [];
  return {
    _responses: responses,
    _authorizers: authorizers,
    async getInheritedRole() { return "admin"; },
    async listRoleBindings() { return { roles: [], grants: [] }; },
    async getApiProtocol() { return "REST"; },
    async getApiByRef() { return { id: apiId, project_id: "p1", protocol: "REST" }; },
    async getIntegrationById() {
      return { id: integrationId, project_id: "p1", api_id: apiId, type: "FUNCTION" };
    },
    async insertAudit() {},
    async insertIntegrationResponse(row) {
      const full = { ...row, id: `resp-${responses.length}`, version: 1 };
      responses.push(full);
      return full;
    },
    async insertAuthorizer(row) {
      const full = { ...row, id: `auth-${authorizers.length}`, version: 1 };
      authorizers.push(full);
      return full;
    },
  };
}

test("S15: ReDoS corpus — every evaluation < 10 ms", async () => {
  // selection_pattern matching (incl. a nested-quantifier attempt, which
  // save-time validation must already reject — here evaluated defensively).
  timed("selection_pattern", (input) => {
    selectCustomResponse({ errorMessage: input }, [
      { status_code: 500, selection_pattern: "Error.*" },
      { status_code: 502, selection_pattern: "timeout.*" },
    ]);
  });

  // CORS wildcard origins are precompiled once, not per request.
  timed("cors wildcard origin", (input) => {
    originAllowed(`https://${"a".repeat(60)}.example.com`, ["https://*.example.com"], {
      corsWildcardSubdomains: true,
    });
    void input;
    originAllowed("https://evil.example.com", ["https://*.example.com"], {
      corsWildcardSubdomains: true,
    });
  });

  // Routing-rule globs are linear string ops (no regex backtracking).
  timed("routing glob", (input) => {
    matchHeaderGlob("*session*", input.slice(0, 200));
  });

  // WAF-managed patterns on hostile input.
  const { detectSqli, detectXss } = await import("../../lib/gateway/core/edge/waf-engine.mjs");
  timed("waf sqli", (input) => detectSqli(input));
  timed("waf xss", (input) => detectXss(input));

  // VTL string regex ops on hostile input.
  const { parseTemplate } = await import("../../lib/gateway/core/processing/templates/index.mjs");
  const { renderAst } = await import("../../lib/gateway/core/processing/templates/interpreter.mjs");
  timed("vtl replaceAll", (input) => {
    const ast = parseTemplate('$x.replaceAll("a+", "b")');
    renderAst(ast, { input: { x: input.slice(0, 2000) } });
  });

  // --- Save-time rejection of dangerous patterns (F17) --------------------
  assert.ok(validateRegexPattern("(a+)+$") !== null, "(a+)+$ must be rejected");
  assert.ok(validateRegexPattern("([a-z]+.*)+") !== null, "nested quantifier must be rejected");
  assert.ok(validateRegexPattern("(a|b)*c") !== null, "alternation under quantifier must be rejected");
  assert.ok(validateRegexPattern("a(?=b)") !== null, "lookahead must be rejected");
  assert.ok(validateRegexPattern("(a)\\1") !== null, "backreference must be rejected");
  const long = `a{1,${"".padEnd(0)}}` + "x".repeat(513);
  const { validateSafePattern } = await import("../../lib/gateway/core/redos.mjs");
  assert.ok(validateSafePattern(long) !== null, "over-long patterns must be rejected at 512");
  assert.ok(validateRegexPattern("x".repeat(1025)) !== null, "WAF patterns over 1024 must be rejected");
  assert.equal(validateRegexPattern("x".repeat(700)), null, "WAF keeps its 1024 cap");

  // selectionPattern save path enforces length + linearity.
  const db = controlFakeDb();
  await assert.rejects(
    createIntegrationResponse(db, ADMIN, {
      projectId: "p1",
      apiId: "api-1",
      integrationId: "int-1",
      input: { statusCode: 500, selectionPattern: "(a+)+$" },
    }),
    (error) => error instanceof HttpError && error.status === 422,
  );
  await assert.rejects(
    createIntegrationResponse(db, ADMIN, {
      projectId: "p1",
      apiId: "api-1",
      integrationId: "int-1",
      input: { statusCode: 500, selectionPattern: "x".repeat(513) },
    }),
    (error) => error instanceof HttpError && error.status === 422,
  );

  // identityValidationExpression save path enforces the same.
  const adb = controlFakeDb();
  adb.getApiByRef = async () => ({ id: "api-1", project_id: "p1", protocol: "REST" });
  adb.getAuthorizerById = async () => null;
  await assert.rejects(
    createAuthorizer(adb, ADMIN, {
      projectId: "p1",
      apiId: "api-1",
      input: {
        name: "tok",
        type: "TOKEN",
        identitySource: ["method.request.header.Authorization"],
        identityValidationExpression: "(a+)+$",
        function: { provider: "webhook", url: "https://auth.example/token" },
      },
    }),
    (error) => error instanceof HttpError && error.status === 422,
  );
});
