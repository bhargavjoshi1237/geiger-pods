/**
 * Payload compression (spec §8, `node:zlib`).
 *
 * When `minimum_compression_size` is set (0–10485760): requests with
 * `Content-Encoding: gzip|deflate` are decompressed before
 * validation/templates (proxy integrations receive the original encoded body
 * plus header); unknown encodings → 415. Responses with a body at or above
 * the threshold, a client `Accept-Encoding` containing `gzip`/`deflate`
 * (`br` is a Pods extension, off by default) and no backend
 * `Content-Encoding` are compressed. `Vary: Accept-Encoding` is added; never
 * for streaming, 204 or 304.
 *
 * @module lib/gateway/core/processing/compression
 */

import { gzipSync, deflateSync, gunzipSync, inflateSync, brotliCompressSync } from "node:zlib";
import { GatewayError } from "../errors.mjs";

/** Valid range for `minimum_compression_size` (bytes). */
export const MAX_COMPRESSION_SIZE = 10 * 1024 * 1024;

/**
 * Parses an `Accept-Encoding` header into ordered `{ encoding, quality }`.
 *
 * @param {string|null} [header=null]
 * @returns {Array<{ encoding: string, quality: number }>}
 */
export function parseAcceptEncoding(header = null) {
  if (!header) return [];
  return String(header)
    .split(",")
    .map((part) => {
      const [encoding, ...params] = part.trim().split(";");
      let quality = 1;
      for (const param of params) {
        const match = param.trim().match(/^q=([0-9.]+)$/);
        if (match) quality = Number(match[1]);
      }
      return { encoding: encoding.trim().toLowerCase(), quality };
    })
    .filter((entry) => entry.encoding.length > 0 && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality);
}

/**
 * Decompresses an inbound request body per `Content-Encoding`. Returns the
 * decoded bytes; unknown encodings throw 415 `UNSUPPORTED_MEDIA_TYPE`.
 *
 * @param {{ body?: Uint8Array, contentEncoding?: string|null }} [input={}]
 * @returns {Uint8Array}
 * @throws {GatewayError} 415 on unknown encodings or corrupt payloads.
 */
export function decompressRequestBody(input = {}) {
  const { body = new Uint8Array(), contentEncoding = null } = input;
  const encoding = String(contentEncoding ?? "").split(",")[0].trim().toLowerCase();
  if (!encoding || encoding === "identity") return body instanceof Uint8Array ? body : new Uint8Array(body);
  const bytes = Buffer.from(body);
  try {
    if (encoding === "gzip" || encoding === "x-gzip") return new Uint8Array(gunzipSync(bytes));
    if (encoding === "deflate") return new Uint8Array(inflateSync(bytes));
  } catch {
    throw new GatewayError("BAD_REQUEST_BODY", "Invalid request body");
  }
  throw new GatewayError("UNSUPPORTED_MEDIA_TYPE", "Unsupported Media Type");
}

/**
 * Negotiates response compression. Returns the encoding to apply or null.
 *
 * @param {{ statusCode?: number, bodyLength?: number, threshold?: number|null, acceptEncoding?: string|null, backendContentEncoding?: string|null, streaming?: boolean, brotliEnabled?: boolean }} [input={}]
 * @returns {"gzip"|"deflate"|"br"|null}
 */
export function negotiateResponseCompression(input = {}) {
  const {
    statusCode = 200,
    bodyLength = 0,
    threshold = null,
    acceptEncoding = null,
    backendContentEncoding = null,
    streaming = false,
    brotliEnabled = false,
  } = input;
  if (threshold === null || threshold === undefined) return null;
  if (streaming || statusCode === 204 || statusCode === 304) return null;
  if (backendContentEncoding) return null;
  if ((bodyLength ?? 0) < threshold) return null;
  const accepted = parseAcceptEncoding(acceptEncoding);
  const names = new Set(accepted.map((entry) => entry.encoding));
  if (names.has("gzip") || names.has("x-gzip") || names.has("*")) return "gzip";
  if (names.has("deflate")) return "deflate";
  if (brotliEnabled && names.has("br")) return "br";
  return null;
}

/**
 * Compresses response bytes with the negotiated encoding.
 *
 * @param {Uint8Array} body
 * @param {"gzip"|"deflate"|"br"} encoding
 * @returns {Uint8Array}
 */
export function compressBody(body, encoding) {
  const bytes = Buffer.from(body);
  if (encoding === "gzip") return new Uint8Array(gzipSync(bytes));
  if (encoding === "deflate") return new Uint8Array(deflateSync(bytes));
  if (encoding === "br") return new Uint8Array(brotliCompressSync(bytes));
  throw new GatewayError("API_CONFIGURATION_ERROR", "Internal server error");
}

/**
 * Applies compression to a response, returning new headers/body.
 *
 * @param {{ statusCode?: number, headers?: Record<string,string>, body?: Uint8Array }} response
 * @param {{ threshold?: number|null, acceptEncoding?: string|null, streaming?: boolean, brotliEnabled?: boolean }} [options={}]
 * @returns {{ headers: Record<string,string>, body: Uint8Array }}
 */
export function applyResponseCompression(response = {}, options = {}) {
  const body = response.body instanceof Uint8Array ? response.body : new Uint8Array();
  const headers = { ...(response.headers ?? {}) };
  const backendEncoding = headers["content-encoding"] ?? headers["Content-Encoding"] ?? null;
  const encoding = negotiateResponseCompression({
    statusCode: response.statusCode ?? 200,
    bodyLength: body.length,
    threshold: options.threshold ?? null,
    acceptEncoding: options.acceptEncoding ?? headers["accept-encoding"] ?? null,
    backendContentEncoding: backendEncoding,
    streaming: options.streaming ?? false,
    brotliEnabled: options.brotliEnabled ?? false,
  });
  if (!encoding) return { headers, body };
  const compressed = compressBody(body, encoding);
  const next = { ...headers };
  for (const key of Object.keys(next)) {
    if (key.toLowerCase() === "content-length") delete next[key];
  }
  next["content-encoding"] = encoding;
  appendVaryEncoding(next);
  return { headers: next, body: compressed };
}

function appendVaryEncoding(headers) {
  const key = Object.keys(headers).find((name) => name.toLowerCase() === "vary");
  if (!key) {
    headers.vary = "Accept-Encoding";
    return;
  }
  const parts = String(headers[key]).split(",").map((part) => part.trim().toLowerCase());
  if (!parts.includes("accept-encoding")) headers[key] = `${headers[key]}, Accept-Encoding`;
}
