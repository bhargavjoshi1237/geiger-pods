/**
 * MOCK adapter (S04 §3.2). No network: the status comes from the rendered
 * request template's JSON `statusCode` (default 200); integration responses
 * (S06) produce body and headers from the returned payload. With no template
 * the result is 200 with an empty body.
 *
 * @module lib/gateway/core/integrations/mock
 */

/**
 * Invokes a MOCK integration.
 *
 * @param {object} _ctx - Pipeline context (unused; kept for the adapter signature).
 * @param {object} _integration - Integration config (unused).
 * @param {{ renderedTemplate?: string | null }} [outbound={}] - S06 template output.
 * @returns {Promise<{ status: number, headers: Headers, body: Uint8Array | null, latencyMs: number, mockPayload: unknown }>}
 */
export async function invokeMock(_ctx, _integration, outbound = {}) {
  const started = Date.now();
  const raw = outbound?.renderedTemplate ?? null;
  if (raw === null || raw === undefined || String(raw).length === 0) {
    return { status: 200, headers: new Headers(), body: new Uint8Array(0), latencyMs: Date.now() - started, mockPayload: null };
  }
  let payload = null;
  try {
    payload = JSON.parse(String(raw));
  } catch {
    payload = String(raw);
  }
  const status = payload && typeof payload === "object" && Number.isInteger(payload.statusCode)
    ? payload.statusCode
    : 200;
  return {
    status,
    headers: new Headers(),
    body: new Uint8Array(0),
    latencyMs: Date.now() - started,
    mockPayload: payload,
  };
}
