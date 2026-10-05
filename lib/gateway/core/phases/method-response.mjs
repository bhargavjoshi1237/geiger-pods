/**
 * `methodResponse` phase (pipeline row 19 — CORS response headers,
 * compression, cache store).
 *
 * S06W implementation of the S06 half (keeping the `name` + `run(ctx)`
 * contract; S09 owns cache lookup/store and streaming and extends this
 * module). Builds the final client `Response` from `ctx.s06result` (set by
 * `integrationResponse`):
 *
 * 1. Content-Type defaults to the selected template/backend type.
 * 2. Payload compression (`minimum_compression_size`, `node:zlib`):
 *    bodies at or above the threshold with a client `Accept-Encoding` of
 *    `gzip`/`deflate` (`br` only with `features.brotliCompression`) and no
 *    backend `Content-Encoding` are compressed; `Vary: Accept-Encoding` is
 *    added. Never for 204/304.
 * 3. Managed HTTP CORS headers replace backend CORS headers.
 *
 * Returns the final `Response` (short-circuits the pipeline, as `invoke`
 * used to). Returns `undefined` when the S06 request phases did not run
 * (non-HTTP/REST protocols, unmatched requests, or the S05 invoke fallback).
 *
 * @module lib/gateway/core/phases/method-response
 */

import { withManagedCors } from "../processing/runtime.mjs";
import {
  compressBody,
  negotiateResponseCompression,
} from "../processing/compression.mjs";

/** Phase name as listed in the pipeline table (§3). */
export const name = "methodResponse";

/**
 * Builds the final client response.
 *
 * @param {object} ctx - Pipeline context.
 * @returns {Promise<Response|undefined>} Final response, or `undefined`.
 */
export async function run(ctx) {
  const staged = ctx?.s06result ?? null;
  if (!ctx?.s06?.built || !staged) return undefined;
  const artifact = ctx?.artifact ?? {};
  const settings = artifact.settings ?? {};
  const features = artifact.features ?? {};

  let status = staged.status ?? 200;
  if (!Number.isInteger(status) || status < 100 || status > 599) status = 500;
  let body = staged.body instanceof Uint8Array ? staged.body : null;
  if (status === 204 || status === 304) body = null;
  const headers = new Headers(staged.headers ?? {});
  if (!headers.has("content-type")) {
    if (staged.contentType) {
      try {
        headers.set("content-type", staged.contentType);
      } catch {
        // Leave the header unset when illegal.
      }
    } else if (body && body.byteLength > 0) {
      // S05 parity: a body without a type is JSON (upstream echoes, MOCK
      // payloads and function outputs are JSON by default).
      try {
        headers.set("content-type", "application/json");
      } catch {
        // Leave the header unset when illegal.
      }
    }
  }

  // Payload compression (spec §8).
  const threshold = settings.minimumCompressionSize ?? null;
  if (threshold !== null && threshold !== undefined && body && body.byteLength > 0) {
    let acceptEncoding = null;
    try {
      acceptEncoding = ctx.request.headers.get("accept-encoding");
    } catch {
      acceptEncoding = null;
    }
    const encoding = negotiateResponseCompression({
      statusCode: status,
      bodyLength: body.byteLength,
      threshold,
      acceptEncoding,
      backendContentEncoding: headers.get("content-encoding"),
      streaming: false,
      brotliEnabled: features.brotliCompression ?? false,
    });
    if (encoding) {
      body = compressBody(body, encoding);
      try {
        headers.set("content-encoding", encoding);
      } catch {
        // Leave the header unset when illegal.
      }
      appendVary(headers, "Accept-Encoding");
      try {
        headers.delete("content-length");
      } catch {
        // Keep a stale content-length rather than failing the request.
      }
    }
  }

  let response;
  try {
    response = new Response(body && body.byteLength > 0 ? body : null, { status, headers });
  } catch {
    response = new Response("Internal server error", {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  return withManagedCors(ctx, response);
}

/**
 * Appends a value to `Vary` unless already present.
 *
 * @param {Headers} headers
 * @param {string} value
 */
function appendVary(headers, value) {
  const current = headers.get("vary");
  if (!current) {
    try {
      headers.set("vary", value);
    } catch {
      // Leave Vary unset when illegal.
    }
    return;
  }
  const parts = current.split(",").map((part) => part.trim().toLowerCase());
  if (!parts.includes(value.toLowerCase())) {
    try {
      headers.set("vary", `${current}, ${value}`);
    } catch {
      // Keep the existing Vary rather than failing the request.
    }
  }
}
