/**
 * Edge-endpoint response headers (S11 Part C).
 *
 * An API with `edge.endpointType === "EDGE"` is fronted by Pods' global edge
 * layer (multi-region runtime behind anycast or a CDN). The edge adds a
 * `Via` header to client responses, mirroring how AWS edge-optimized APIs
 * carry a CloudFront `Via` header. Infrastructure requirements live in
 * `docs/ops/edge.md`; acceptance at this stage is config-level.
 *
 * @module lib/gateway/core/edge/edge-headers
 */

/** `Via` value sent for EDGE endpoints (AWS: `1.1 <id>.cloudfront.net`). */
export const EDGE_VIA = "1.1 pods-edge";

/**
 * Returns true when the artifact routes through the global edge layer.
 *
 * @param {object} [artifact={}]
 * @returns {boolean}
 */
export function isEdgeEndpoint(artifact = {}) {
  return String(artifact?.edge?.endpointType ?? artifact?.endpointType ?? "REGIONAL").toUpperCase() === "EDGE";
}

/**
 * Adds edge headers to a final client response (no-op unless EDGE).
 * Returns the same response for chaining.
 *
 * @param {object} [ctx={}] - Pipeline context (`artifact`).
 * @param {Response} response - Final client response.
 * @returns {Response}
 */
export function applyEdgeHeaders(ctx = {}, response) {
  if (!response) return response;
  try {
    if (isEdgeEndpoint(ctx?.artifact)) response.headers.set("Via", EDGE_VIA);
  } catch {
    // Headers must never break responses.
  }
  return response;
}
