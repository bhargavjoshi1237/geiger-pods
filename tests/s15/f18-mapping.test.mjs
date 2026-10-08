/**
 * F18 (S15 part 2): mapping + encoding correctness.
 *
 * - Multivalue lookups are case-insensitive and resolve to the right bag
 *   (`method.request.multivalueheader.X` reads request headers;
 *   `multivaluequerystring` reads query params; gateway-response params
 *   match multivalue query names case-insensitively).
 * - `status_code` overrides are validated (100–599 integers only); invalid
 *   customization falls back to the type default instead of throwing or
 *   sending an illegal status.
 * - `truncateBody` truncates by UTF-8 bytes without splitting a multi-byte
 *   character (byte length ≤ cap, round-trips as valid UTF-8).
 * - Response compression reads `Content-Encoding`/`Accept-Encoding`
 *   case-insensitively (any header casing disables double-compression and
 *   negotiates correctly).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyRestRequestMapping,
  truncateBody,
  HTTP_BODY_TRUNCATE_BYTES,
} from "../../lib/gateway/core/processing/param-mapping.mjs";
import { resolveGatewayParameter } from "../../lib/gateway/core/gateway-responses.mjs";
import { renderCustomGatewayResponse } from "../../lib/gateway/core/gateway-responses.mjs";
import {
  applyResponseCompression,
  negotiateResponseCompression,
} from "../../lib/gateway/core/processing/compression.mjs";

test("F18: multivalue request lookups hit the right bag case-insensitively", () => {
  const data = {
    methodRequest: {
      headers: { "X-Custom": "headervalue" },
      querystring: { Page: "queryvalue" },
      path: {},
    },
    bodyText: "",
    context: {},
    stageVariables: {},
  };
  const mapped = applyRestRequestMapping(
    {
      "integration.request.header.out": "method.request.multivalueheader.x-custom",
      "integration.request.querystring.out": "method.request.multivaluequerystring.page",
    },
    data,
  );
  assert.equal(mapped.headers.out, "headervalue");
  assert.equal(mapped.querystring.out, "queryvalue");

  const gateway = resolveGatewayParameter("method.request.multivaluequerystring.PAGE", {
    methodRequest: { querystring: { page: "gatewayvalue" } },
    stageVariables: {},
    context: {},
  });
  assert.equal(gateway, "gatewayvalue");
});

test("F18: invalid gateway-response status_code falls back to the default", async () => {
  const ctx = { requestId: "req-f18", context: { requestId: "req-f18" } };
  for (const bad of ["999", "abc", "99", "600", ""]) {
    const response = await renderCustomGatewayResponse(
      { type: "THROTTLED", message: "Too Many Requests" },
      ctx,
      [{ response_type: "THROTTLED", status_code: bad }],
      {},
    );
    assert.equal(response.status, 429, `status_code ${JSON.stringify(bad)} must fall back to 429`);
  }
  const ok = await renderCustomGatewayResponse(
    { type: "THROTTLED", message: "Too Many Requests" },
    ctx,
    [{ response_type: "THROTTLED", status_code: "503" }],
    {},
  );
  assert.equal(ok.status, 503);
});

test("F18: truncateBody is byte-accurate and never splits UTF-8", () => {
  assert.equal(HTTP_BODY_TRUNCATE_BYTES, 100 * 1024);
  const emoji = "😀"; // 4 UTF-8 bytes, 2 UTF-16 units.
  const long = `${"a".repeat(HTTP_BODY_TRUNCATE_BYTES - 2)}${emoji}${"b".repeat(10)}`;
  const truncated = truncateBody(long);
  assert.ok(Buffer.byteLength(truncated, "utf8") <= HTTP_BODY_TRUNCATE_BYTES);
  assert.ok(!truncated.endsWith("�"), "must not end with a replacement character");
  // The split emoji is dropped entirely (no half-surrogate).
  for (const char of truncated) {
    assert.notEqual(char.codePointAt(0), 0xfffd);
  }
  // Short bodies pass through untouched.
  assert.equal(truncateBody("hello"), "hello");
  // Multi-byte body exactly at the cap stays intact when it fits.
  const exact = "é".repeat(50 * 1024); // 2 bytes each → exactly 100 KB.
  assert.equal(Buffer.byteLength(exact, "utf8"), HTTP_BODY_TRUNCATE_BYTES);
  assert.equal(truncateBody(exact), exact);
});

test("F18: compression honors header casing (no double-compress, negotiates)", () => {
  const body = new Uint8Array(Buffer.alloc(2048, 1));
  // Backend already encoded (any casing) → never compress again.
  for (const headers of [
    { "Content-Encoding": "gzip" },
    { "content-encoding": "gzip" },
    { "CONTENT-ENCODING": "gzip" },
  ]) {
    const out = applyResponseCompression(
      { statusCode: 200, headers, body },
      { threshold: 1024, acceptEncoding: "gzip" },
    );
    assert.equal(out.body.length, body.length, `must not recompress over ${JSON.stringify(headers)}`);
  }
  // Accept-Encoding in any casing still negotiates.
  const negotiated = negotiateResponseCompression({
    statusCode: 200,
    bodyLength: 2048,
    threshold: 1024,
    acceptEncoding: "GZip",
    backendContentEncoding: null,
  });
  assert.equal(negotiated, "gzip");
  const applied = applyResponseCompression(
    { statusCode: 200, headers: { "content-type": "application/json" }, body },
    { threshold: 1024, acceptEncoding: "GZIP" },
  );
  assert.equal(applied.headers["content-encoding"], "gzip");
});
