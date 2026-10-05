import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  applyResponseCompression,
  decompressRequestBody,
  negotiateResponseCompression,
} from "../../lib/gateway/core/processing/compression.mjs";
import { GatewayError } from "../../lib/gateway/core/errors.mjs";

function bytesOf(text, repeat = 1) {
  return new Uint8Array(Buffer.from(text.repeat(repeat), "utf8"));
}

test("S06: gzip request body decompressed for templates; response ≥ threshold compressed only with Accept-Encoding gzip; below threshold not", () => {
  const original = bytesOf("hello templates! ", 200);

  // Requests with Content-Encoding: gzip inflate before validation/templates.
  const gzipped = new Uint8Array(gzipSync(Buffer.from(original)));
  const inflated = decompressRequestBody({ body: gzipped, contentEncoding: "gzip" });
  assert.deepEqual(Buffer.from(inflated), Buffer.from(original));
  // Identity / absent encoding passes through.
  assert.deepEqual(Buffer.from(decompressRequestBody({ body: original, contentEncoding: null })), Buffer.from(original));
  // Unknown encodings → 415.
  assert.throws(() => decompressRequestBody({ body: original, contentEncoding: "compress" }), (error) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.type, "UNSUPPORTED_MEDIA_TYPE");
    assert.equal(error.statusCode, 415);
    return true;
  });

  // Responses at/above the threshold compress when the client accepts gzip…
  const big = bytesOf("0123456789abcdef", 100);
  assert.equal(negotiateResponseCompression({
    statusCode: 200,
    bodyLength: big.length,
    threshold: 100,
    acceptEncoding: "gzip, deflate",
  }), "gzip");
  const compressed = applyResponseCompression(
    { statusCode: 200, headers: { "content-type": "application/json" }, body: big },
    { threshold: 100, acceptEncoding: "gzip" },
  );
  assert.equal(compressed.headers["content-encoding"], "gzip");
  assert.ok(compressed.body.length < big.length);
  assert.ok(String(compressed.headers.vary).includes("Accept-Encoding"));
  assert.equal(compressed.headers["content-type"], "application/json");

  // …but not below the threshold, without Accept-Encoding, with a backend
  // Content-Encoding, for 204/304, or when compression is unset.
  const small = bytesOf("tiny");
  assert.equal(negotiateResponseCompression({ statusCode: 200, bodyLength: small.length, threshold: 100, acceptEncoding: "gzip" }), null);
  assert.equal(negotiateResponseCompression({ statusCode: 200, bodyLength: big.length, threshold: 100, acceptEncoding: "identity" }), null);
  assert.equal(negotiateResponseCompression({ statusCode: 200, bodyLength: big.length, threshold: null, acceptEncoding: "gzip" }), null);
  assert.equal(negotiateResponseCompression({ statusCode: 204, bodyLength: big.length, threshold: 100, acceptEncoding: "gzip" }), null);
  assert.equal(negotiateResponseCompression({
    statusCode: 200,
    bodyLength: big.length,
    threshold: 100,
    acceptEncoding: "gzip",
    backendContentEncoding: "gzip",
  }), null);
  const untouched = applyResponseCompression(
    { statusCode: 200, headers: {}, body: small },
    { threshold: 100, acceptEncoding: "gzip" },
  );
  assert.deepEqual(Buffer.from(untouched.body), Buffer.from(small));
  assert.equal(untouched.headers["content-encoding"], undefined);

  // br is a Pods extension, off by default.
  assert.equal(negotiateResponseCompression({ statusCode: 200, bodyLength: big.length, threshold: 100, acceptEncoding: "br" }), null);
  assert.equal(negotiateResponseCompression({
    statusCode: 200, bodyLength: big.length, threshold: 100, acceptEncoding: "br", brotliEnabled: true,
  }), "br");
});
