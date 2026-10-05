import assert from "node:assert/strict";
import test from "node:test";
import { PRESETS, validateAccessLogFormat, renderAccessLog, toAccessLogRow } from "../../lib/gateway/core/observe/access-log.mjs";
import { HttpError } from "../../lib/control/errors.mjs";

function fixtureCtx() {
  return {
    context: {
      requestId: "c6af9ac6-7b61-11e6-9a41-93e8deadbeef",
      requestTime: "12/Oct/2026:12:00:00 +0000",
      httpMethod: "GET",
      resourcePath: "/pets",
      protocol: "https",
      status: "200",
      responseLength: "142",
      identity: { sourceIp: "192.0.2.1", caller: "-", user: "-" },
      error: { message: "", messageString: '""' },
    },
  };
}

test("S10: CLF and JSON presets render exactly the AWS strings for a fixture context; format without requestId rejected", () => {
  const clf = renderAccessLog(PRESETS.CLF, fixtureCtx());
  assert.equal(clf, '192.0.2.1 - - [12/Oct/2026:12:00:00 +0000] "GET /pets https" 200 142 c6af9ac6-7b61-11e6-9a41-93e8deadbeef');
  const json = JSON.parse(renderAccessLog(PRESETS.JSON, fixtureCtx()));
  assert.deepEqual(json, {
    requestId: "c6af9ac6-7b61-11e6-9a41-93e8deadbeef",
    ip: "192.0.2.1",
    caller: "-",
    user: "-",
    requestTime: "12/Oct/2026:12:00:00 +0000",
    httpMethod: "GET",
    resourcePath: "/pets",
    status: "200",
    protocol: "https",
    responseLength: "142",
  });
  assert.ok(PRESETS.XML.includes("$context.requestId"));
  assert.ok(PRESETS.CSV.includes("$context.requestId"));
  assert.throws(
    () => validateAccessLogFormat("$context.status $context.httpMethod"),
    (error) => error instanceof HttpError && error.status === 422,
  );
  assert.throws(
    () => validateAccessLogFormat("$context.requestId $context.nope.unknown"),
    (error) => error instanceof HttpError && error.status === 422,
  );
  assert.throws(
    () => validateAccessLogFormat(`$context.requestId ${"x".repeat(3072)}`),
    (error) => error instanceof HttpError && error.status === 413,
  );
  assert.deepEqual(validateAccessLogFormat(PRESETS.CLF).variables.length > 0, true);
});

test("S10: unknown variables render empty at runtime; rows carry searchable fields", () => {
  const line = renderAccessLog("$context.requestId $context.authorizer.claims.sub", fixtureCtx());
  assert.ok(line.startsWith("c6af9ac6-7b61-11e6-9a41-93e8deadbeef "), line);
  const row = toAccessLogRow({
    projectId: "p1", apiId: "a1", stage: "prod", ts: "2026-10-09T00:00:00.000Z",
    requestId: "r1", status: 200, routeKey: "GET /pets", sourceIp: "192.0.2.1",
  }, line);
  assert.equal(row.request_id, "r1");
  assert.equal(row.status, 200);
  assert.equal(row.route, "GET /pets");
  assert.equal(row.source_ip, "192.0.2.1");
  assert.equal(row.line, line);
});
