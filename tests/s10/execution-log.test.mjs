import assert from "node:assert/strict";
import test from "node:test";
import {
  levelEnabled, maskHeaderValue, maskSecretsInText, formatMaskedHeaders,
  traceBody, createExecutionLogCollector, openingLines, toExecutionLogRow,
} from "../../lib/gateway/core/observe/execution-log.mjs";

test("S10: execution log contains AWS-vocabulary lines in order for a REST HTTP integration; ERROR level only logs failures", () => {
  const collector = createExecutionLogCollector();
  const lines = [
    ["INFO", "Extended Request Id: abc="],
    ["INFO", "Verifying Usage Plan for request: abc="],
    ["INFO", "Method request path: {proxy=/pets}"],
    ["INFO", "Method request query string: {q=1}"],
    ["INFO", "Method request headers: {accept=application/json}"],
    ["INFO", "Method request body before transformations: {\"a\":1}"],
    ["INFO", "Endpoint request URI: https://backend.local/pets"],
    ["INFO", "Endpoint request headers: {accept=application/json}"],
    ["INFO", "Endpoint request body after transformations: {\"a\":1}"],
    ["INFO", "Sending request to https://backend.local/pets"],
    ["INFO", "Received response. Status: 200, Integration latency: 45 ms"],
    ["INFO", "Endpoint response headers: {content-type=application/json}"],
    ["INFO", "Endpoint response body before transformations: [200] {\"ok\":true}"],
    ["INFO", "Method response body after transformations: {\"ok\":true}"],
    ["INFO", "Method response headers: {Content-Type=application/json}"],
    ["INFO", "Successfully completed execution"],
    ["INFO", "Method completed with status: 200"],
  ];
  for (const [level, message] of lines) collector.trace(level, message);
  const ordered = collector.lines.map((line) => line.message);
  assert.deepEqual(ordered, lines.map(([, message]) => message));
  const event = { projectId: "p1", apiId: "a1", stage: "prod", requestId: "r1", ts: "2026-10-09T00:00:00.000Z" };
  const infoRow = toExecutionLogRow(event, collector.lines, { loggingLevel: "INFO" });
  assert.equal(infoRow.lines.length, 17);
  // ERROR level keeps failures only.
  collector.trace("ERROR", "Execution failed: backend timeout");
  const errorRow = toExecutionLogRow(event, collector.lines, { loggingLevel: "ERROR" });
  assert.equal(errorRow.lines.length, 1);
  assert.match(errorRow.lines[0].message, /Execution failed/);
  assert.equal(toExecutionLogRow(event, collector.lines, { loggingLevel: "OFF" }), null);
  assert.ok(levelEnabled("ERROR", "ERROR") && !levelEnabled("ERROR", "INFO") && !levelEnabled("OFF", "ERROR"));
  assert.deepEqual(openingLines({ context: { extendedRequestId: "abc=" }, requestId: "r" }), [["INFO", "Extended Request Id: abc="]]);
});

test("S10: Authorization, cookies, x-api-key and backend_auth values are masked even with data trace; bodies only with data trace and truncated to 1 KB", () => {
  const secret = "super-secret-value";
  const options = { backendAuthHeaders: ["x-backend-token"], secretValues: [secret] };
  assert.equal(maskHeaderValue("authorization", "Bearer abc", options), "****");
  assert.equal(maskHeaderValue("Cookie", "session=1", options), "****");
  assert.equal(maskHeaderValue("x-api-key", "abcdef123456", options), "****3456");
  assert.equal(maskHeaderValue("x-backend-token", "tok", options), "****");
  assert.equal(maskHeaderValue("x-custom", secret, options), "****");
  assert.equal(maskHeaderValue("accept", "application/json", options), "application/json");
  assert.equal(
    formatMaskedHeaders({ authorization: "Bearer x", "x-api-key": "key-12345678", accept: "application/json" }, options),
    JSON.stringify({ authorization: "****", "x-api-key": "****5678", accept: "application/json" }),
  );
  assert.match(maskSecretsInText(`token=${secret}&a=1`, options), /\*\*\*\*/);
  assert.equal(traceBody("hello", { dataTraceEnabled: false }), null);
  assert.equal(traceBody("hello", { dataTraceEnabled: true }), "hello");
  const big = "x".repeat(5000);
  assert.equal(traceBody(big, { dataTraceEnabled: true }).length, 1024);
  assert.equal(traceBody(`prefix ${secret} suffix`, { dataTraceEnabled: true, secretValues: [secret] }).includes(secret), false);
});
