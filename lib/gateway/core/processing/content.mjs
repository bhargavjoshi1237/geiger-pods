/**
 * Binary media types and content handling (spec §7).
 *
 * Entries are a MIME type or wildcard (`image/*`, `*∕*`). A body is binary
 * when its Content-Type matches. Request conversion follows
 * `integration.content_handling`; responses use the integration response's
 * `content_handling`. Byte preservation: proxy integrations never re-encode.
 *
 * @module lib/gateway/core/processing/content
 */

/**
 * True when `contentType` matches one of `binaryMediaTypes` (case-insensitive,
 * parameters stripped, `type/*` and `*∕*` wildcards).
 *
 * @param {string|null} [contentType=null]
 * @param {Array<string>} [binaryMediaTypes=[]]
 * @returns {boolean}
 */
export function isBinaryContent(contentType, binaryMediaTypes = []) {
  const normalized = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  if (!normalized) return false;
  for (const entry of binaryMediaTypes ?? []) {
    const pattern = String(entry ?? "").split(";")[0].trim().toLowerCase();
    if (!pattern) continue;
    if (pattern === "*/*") return true;
    if (pattern.endsWith("/*")) {
      if (normalized.startsWith(pattern.slice(0, -1))) return true;
      continue;
    }
    if (normalized === pattern) return true;
  }
  return false;
}

/**
 * Converts an inbound request body per `contentHandling`.
 * Returns `{ bytes, templateText }`: `bytes` go to the integration,
 * `templateText` is what mapping templates see.
 *
 * - binary body + passthrough (null) → bytes unchanged; templates see the
 *   base64 string (AWS behavior).
 * - `CONVERT_TO_TEXT` → binary is base64-encoded for the integration.
 * - `CONVERT_TO_BINARY` → a text body is base64-decoded into bytes.
 *
 * @param {{ body?: Uint8Array|string, contentType?: string|null, contentHandling?: string|null, binaryMediaTypes?: Array<string> }} [input={}]
 * @returns {{ bytes: Uint8Array, templateText: string }}
 */
export function convertRequestBody(input = {}) {
  const { body = new Uint8Array(), contentType = null, contentHandling = null, binaryMediaTypes = [] } = input;
  const bytes = toBytes(body);
  const binary = isBinaryContent(contentType, binaryMediaTypes);
  if (contentHandling === "CONVERT_TO_TEXT" && binary) {
    const text = Buffer.from(bytes).toString("base64");
    return { bytes: Buffer.from(text, "utf8"), templateText: text };
  }
  if (contentHandling === "CONVERT_TO_BINARY" && !binary) {
    const text = Buffer.from(bytes).toString("utf8").trim();
    try {
      const decoded = Buffer.from(text, "base64");
      // Guard: only treat as base64 when it round-trips (else keep bytes).
      if (decoded.toString("base64").replace(/=+$/, "") === text.replace(/\s+/g, "").replace(/=+$/, "") && text.length > 0) {
        return { bytes: new Uint8Array(decoded), templateText: Buffer.from(decoded).toString("utf8") };
      }
    } catch {
      // fall through with the original bytes
    }
    return { bytes, templateText: Buffer.from(bytes).toString("utf8") };
  }
  if (binary) {
    return { bytes, templateText: Buffer.from(bytes).toString("base64") };
  }
  return { bytes, templateText: Buffer.from(bytes).toString("utf8") };
}

/**
 * Converts an integration response body per `contentHandling`, deciding
 * binary-ness from the request's `Accept` header first type (AWS uses
 * `Accept`). Function-proxy `{isBase64Encoded: true}` payloads are decoded
 * to bytes when the Accept/Content-Type is binary-listed; otherwise the
 * base64 text is returned unchanged (documented AWS gotcha).
 *
 * @param {{ body?: Uint8Array|string, contentType?: string|null, acceptHeader?: string|null, contentHandling?: string|null, binaryMediaTypes?: Array<string>, isBase64Encoded?: boolean }} [input={}]
 * @returns {{ bytes: Uint8Array, isBinary: boolean }}
 */
export function convertResponseBody(input = {}) {
  const {
    body = new Uint8Array(),
    contentType = null,
    acceptHeader = null,
    contentHandling = null,
    binaryMediaTypes = [],
    isBase64Encoded = false,
  } = input;
  const acceptType = String(acceptHeader ?? "").split(",")[0].split(";")[0].trim() || contentType;
  const acceptBinary = isBinaryContent(acceptType, binaryMediaTypes);
  const contentBinary = isBinaryContent(contentType, binaryMediaTypes);
  // AWS uses Accept for the binary decision; function-proxy isBase64Encoded
  // also honors a binary-listed Content-Type (documented gotcha).
  const binaryForProxy = acceptBinary || contentBinary;
  let bytes = toBytes(body);
  if (isBase64Encoded) {
    const binary = binaryForProxy;
    if (binary) {
      try {
        bytes = new Uint8Array(Buffer.from(Buffer.from(bytes).toString("utf8").trim(), "base64"));
      } catch {
        // keep the base64 text bytes on decode failure
      }
    }
    return { bytes, isBinary: binary };
  }
  if (contentHandling === "CONVERT_TO_BINARY" && !acceptBinary) {
    return { bytes, isBinary: false };
  }
  if (contentHandling === "CONVERT_TO_TEXT" && acceptBinary) {
    return { bytes: Buffer.from(Buffer.from(bytes).toString("base64"), "utf8"), isBinary: false };
  }
  if (contentHandling === "CONVERT_TO_BINARY" && acceptBinary) {
    const text = Buffer.from(bytes).toString("utf8").trim();
    try {
      const decoded = Buffer.from(text, "base64");
      if (text.length > 0) return { bytes: new Uint8Array(decoded), isBinary: true };
    } catch {
      // keep bytes
    }
  }
  return { bytes, isBinary: acceptBinary };
}

function toBytes(body) {
  if (body instanceof Uint8Array) return body;
  if (typeof body === "string") return new Uint8Array(Buffer.from(body, "utf8"));
  if (body === null || body === undefined) return new Uint8Array();
  return new Uint8Array(Buffer.from(String(body), "utf8"));
}
