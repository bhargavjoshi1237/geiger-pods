/**
 * S10 acceptance: access logs (§3) and execution logs (§4).
 *
 * - CLF and JSON presets render exactly the AWS strings for a fixture context.
 * - Format without requestId rejected; unknown variables → 422; >3KB rejected.
 * - Execution log contains AWS-vocabulary lines in order; ERROR level only failures.
 * - Authorization/cookies/x-api-key/backend_auth masked even with data trace;
 *   bodies only with data trace, truncated to 1 KB.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PRESETS,
  renderAccessLog,
  toAccessLogRow,
  validateAccessLogFormat,
} from "../../lib/gateway/core/observe/access-log.mjs";
import {
  buildVocabularyTranscript,
  createExecutionLogCollector,
  formatMaskedHeaders,
  levelEnabled,
  maskHeaderValue,
  toExecutionLogRow,
  traceBody,
} from "../../lib/gateway/core/observe/execution-log.mjs";

function fixtureCtx() {
  return {
    context: {
      requestId: "6f4a8c2e-1111-2222-3333-444455556666",
      extendedRequestId: "AbC123XyZ456=",
      requestTime: "05/Oct/2026:12:00:00 +0000",
      httpMethod: "GET",
      resourcePath: "/pets",
      protocol: "HTTP/1.1",
      status: "200",
      responseLength: "123",
      identity: { sourceIp: "203.0.113.7", caller: "caller-1", user: "user-1" },
    },
  };
}

describe("S10: CLF and JSON presets render exactly the AWS strings for a fixture context", () => {
  it("CLF preset matches the AWS console string", () => {
    const line = renderAccessLog(PRESETS.CLF, fixtureCtx());
    assert.equal(
      line,
      '203.0.113.7 caller-1 user-1 [05/Oct/2026:12:00:00 +0000] "GET /pets HTTP/1.1" 200 123 6f4a8c2e-1111-2222-3333-444455556666',
    );
  });

  it("JSON preset matches the AWS console string", () => {
    const line = renderAccessLog(PRESETS.JSON, fixtureCtx());
    assert.equal(
      line,
      '{ "requestId":"6f4a8c2e-1111-2222-3333-444455556666", "ip": "203.0.113.7", "caller":"caller-1", "user":"user-1","requestTime":"05/Oct/2026:12:00:00 +0000", "httpMethod":"GET","resourcePath":"/pets", "status":"200","protocol":"HTTP/1.1", "responseLength":"123" }',
    );
  });

  it("XML and CSV presets contain the request id", () => {
    const ctx = fixtureCtx();
    assert.match(renderAccessLog(PRESETS.XML, ctx), /6f4a8c2e-1111-2222-3333-444455556666/);
    assert.match(renderAccessLog(PRESETS.CSV, ctx), /^6f4a8c2e-1111-2222-3333-444455556666,/);
  });

  it("row builder splits searchable fields", () => {
    const event = {
      projectId: "p", apiId: "a", stage: "prod", ts: "2026-10-05T12:00:00.000Z",
      requestId: "r1", extendedRequestId: "e1", status: 200, routeKey: "GET /pets",
      sourceIp: "203.0.113.7", httpMethod: "GET", canary: false, latencyMs: 5, traceId: null,
    };
    const row = toAccessLogRow(event, "line");
    assert.equal(row.request_id, "r1");
    assert.equal(row.status, 200);
    assert.equal(row.route, "GET /pets");
    assert.equal(row.source_ip, "203.0.113.7");
  });
});

describe("S10: format without requestId rejected", () => {
  it("rejects formats missing both request id variables", () => {
    assert.throws(
      () => validateAccessLogFormat("$context.status $context.httpMethod"),
      (error) => error.status === 422,
    );
  });

  it("accepts extendedRequestId as the identity variable", () => {
    const out = validateAccessLogFormat("$context.extendedRequestId $context.status");
    assert.deepEqual(out.variables, ["$context.extendedRequestId", "$context.status"]);
  });

  it("rejects unknown variables with 422", () => {
    assert.throws(
      () => validateAccessLogFormat("$context.requestId $context.nope.bogus"),
      (error) => error.status === 422 && /Unknown/.test(error.message),
    );
  });

  it("rejects formats over 3 KB", () => {
    assert.throws(
      () => validateAccessLogFormat(`$context.requestId ${"x".repeat(4 * 1024)}`),
      (error) => error.status === 413,
    );
  });

  it("unknown variables render as empty at runtime (never throw)", () => {
    assert.equal(renderAccessLog("$context.requestId $context.status", fixtureCtx()), `${fixtureCtx().context.requestId} 200`);
  });
});

describe("S10: execution log contains AWS-vocabulary lines in order for a REST HTTP integration; ERROR level only logs failures", () => {
  it("vocabulary transcript follows the AWS order", () => {
    const lines = buildVocabularyTranscript({
      extendedRequestId: "ext-1",
      httpMethod: "GET",
      resourcePath: "/pets",
      path: { id: "abc" },
      query: { q: "x" },
      requestHeaders: { accept: "application/json" },
      endpointUri: "https://backend.example/pets",
      endpointHeaders: { accept: "application/json" },
      integrationLatencyMs: 45,
      integrationStatus: 200,
      responseHeaders: { "content-type": "application/json" },
      status: 200,
    }, { dataTraceEnabled: false });
    const messages = lines.map(([, message]) => message);
    const order = [
      "Extended Request Id:",
      "Method request path:",
      "Method request query string:",
      "Method request headers:",
      "Endpoint request URI:",
      "Sending request to",
      "Received response. Status: 200, Integration latency: 45 ms",
      "Method response headers:",
      "Successfully completed execution",
      "Method completed with status: 200",
    ];
    let cursor = -1;
    for (const needle of order) {
      const index = messages.findIndex((message, at) => at > cursor && message.includes(needle));
      assert.ok(index > cursor, `missing/in-order: ${needle}\n${messages.join("\n")}`);
      cursor = index;
    }
  });

  it("levelEnabled: OFF drops all, ERROR keeps failures only", () => {
    assert.equal(levelEnabled("OFF", "ERROR"), false);
    assert.equal(levelEnabled("OFF", "INFO"), false);
    assert.equal(levelEnabled("ERROR", "ERROR"), true);
    assert.equal(levelEnabled("ERROR", "INFO"), false);
    assert.equal(levelEnabled("INFO", "INFO"), true);
  });

  it("collector + toExecutionLogRow respect the configured level", () => {
    const collector = createExecutionLogCollector();
    collector.trace("INFO", "Method request path: {}");
    collector.trace("ERROR", "Execution failed");
    const errorRow = toExecutionLogRow({ projectId: "p", apiId: "a", stage: "s", requestId: "r" }, collector.lines, { loggingLevel: "ERROR" });
    assert.equal(errorRow.lines.length, 1);
    assert.equal(errorRow.lines[0].level, "ERROR");
    const offRow = toExecutionLogRow({ projectId: "p", apiId: "a", stage: "s", requestId: "r" }, collector.lines, { loggingLevel: "OFF" });
    assert.equal(offRow, null);
  });
});

describe("S10: Authorization, cookies, x-api-key and backend_auth values are masked even with data trace; bodies only with data trace and truncated to 1 KB", () => {
  it("always-masked headers render as ****", () => {
    assert.equal(maskHeaderValue("authorization", "Bearer secret"), "****");
    assert.equal(maskHeaderValue("Cookie", "session=abc"), "****");
    assert.equal(maskHeaderValue("proxy-authorization", "x"), "****");
    assert.equal(maskHeaderValue("set-cookie", "a=b"), "****");
  });

  it("x-api-key shows only the last 4 chars", () => {
    assert.equal(maskHeaderValue("x-api-key", "abcdef123456"), "****3456");
    assert.equal(maskHeaderValue("X-Api-Key", "ab"), "****");
  });

  it("backend_auth-injected headers and secret values are masked", () => {
    const options = { backendAuthHeaders: ["x-backend-token"], secretValues: ["s3cr3t-value"] };
    assert.equal(maskHeaderValue("x-backend-token", "tok", options), "****");
    assert.equal(maskHeaderValue("x-other", "has s3cr3t-value inside", options), "****");
    assert.equal(maskHeaderValue("x-other", "plain", options), "plain");
    const formatted = formatMaskedHeaders(
      { authorization: "Bearer a", "x-api-key": "key-9999", accept: "application/json" },
      {},
    );
    assert.equal(JSON.parse(formatted).authorization, "****");
    assert.equal(JSON.parse(formatted)["x-api-key"], "****9999");
  });

  it("bodies are included only with dataTraceEnabled and truncated to 1 KB", () => {
    assert.equal(traceBody("hello", { dataTraceEnabled: false }), null);
    const big = "b".repeat(5000);
    const traced = traceBody(big, { dataTraceEnabled: true });
    assert.equal(traced.length, 1024);
    assert.equal(traceBody("", { dataTraceEnabled: true }), null);
    assert.equal(traceBody(null, { dataTraceEnabled: true }), null);
  });
});
