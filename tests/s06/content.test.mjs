import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";

import {
  convertRequestBody,
  convertResponseBody,
  isBinaryContent,
} from "../../lib/gateway/core/processing/content.mjs";

const BINARY_TYPES = ["image/png", "application/octet-stream"];

function randomBody(size) {
  // Random bytes, deliberately including invalid UTF-8 sequences.
  return new Uint8Array(randomBytes(size));
}

test("S06: binary round trip of 1 MB random bytes through HTTP_PROXY and FUNCTION_PROXY with Accept image/png; CONVERT_TO_TEXT / CONVERT_TO_BINARY", () => {
  const original = randomBody(1024 * 1024);

  // Media-type matching: exact, wildcard, parameters stripped.
  assert.equal(isBinaryContent("image/png", BINARY_TYPES), true);
  assert.equal(isBinaryContent("image/png; charset=binary", BINARY_TYPES), true);
  assert.equal(isBinaryContent("image/jpeg", ["image/*"]), true);
  assert.equal(isBinaryContent("anything/at-all", ["*/*"]), true);
  assert.equal(isBinaryContent("application/json", BINARY_TYPES), false);
  assert.equal(isBinaryContent(null, BINARY_TYPES), false);

  // HTTP_PROXY path: binary body + passthrough → bytes preserved exactly
  // (no re-encoding), templates see the base64 string.
  const proxy = convertRequestBody({
    body: original,
    contentType: "image/png",
    contentHandling: null,
    binaryMediaTypes: BINARY_TYPES,
  });
  assert.deepEqual(Buffer.from(proxy.bytes), Buffer.from(original));
  assert.equal(proxy.templateText, Buffer.from(original).toString("base64"));

  // Response side: Accept decides binary-ness (AWS uses Accept).
  const proxyResponse = convertResponseBody({
    body: original,
    contentType: "image/png",
    acceptHeader: "image/png",
    binaryMediaTypes: BINARY_TYPES,
  });
  assert.equal(proxyResponse.isBinary, true);
  assert.deepEqual(Buffer.from(proxyResponse.bytes), Buffer.from(original));

  // FUNCTION_PROXY with isBase64Encoded: decoded to bytes when binary-listed…
  const encoded = Buffer.from(original).toString("base64");
  const functionBinary = convertResponseBody({
    body: encoded,
    contentType: "image/png",
    acceptHeader: "image/png",
    binaryMediaTypes: BINARY_TYPES,
    isBase64Encoded: true,
  });
  assert.equal(functionBinary.isBinary, true);
  assert.deepEqual(Buffer.from(functionBinary.bytes), Buffer.from(original));
  // … otherwise the base64 text is returned unchanged (AWS gotcha).
  const functionText = convertResponseBody({
    body: encoded,
    contentType: "application/json",
    acceptHeader: "application/json",
    binaryMediaTypes: BINARY_TYPES,
    isBase64Encoded: true,
  });
  assert.equal(functionText.isBinary, false);
  assert.equal(Buffer.from(functionText.bytes).toString("utf8"), encoded);

  // CONVERT_TO_TEXT: binary is base64-encoded for the integration.
  const toText = convertRequestBody({
    body: original,
    contentType: "image/png",
    contentHandling: "CONVERT_TO_TEXT",
    binaryMediaTypes: BINARY_TYPES,
  });
  assert.equal(Buffer.from(toText.bytes).toString("utf8"), encoded);

  // CONVERT_TO_BINARY: a text (base64) body is decoded into bytes.
  const toBinary = convertRequestBody({
    body: encoded,
    contentType: "application/json",
    contentHandling: "CONVERT_TO_BINARY",
    binaryMediaTypes: BINARY_TYPES,
  });
  assert.deepEqual(Buffer.from(toBinary.bytes), Buffer.from(original));

  // Text bodies on non-binary types pass through untouched.
  const text = convertRequestBody({
    body: '{"hello":"world"}',
    contentType: "application/json",
    binaryMediaTypes: BINARY_TYPES,
  });
  assert.equal(text.templateText, '{"hello":"world"}');
});
