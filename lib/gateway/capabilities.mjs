/**
 * Protocol × feature capability matrix (single source of truth).
 *
 * Mirrors AWS availability exactly: R = REST, H = HTTP, W = WEBSOCKET.
 * The UI hides controls for unsupported capabilities and the control plane
 * rejects writes with `400 {code:"capability_unsupported"}`.
 * Relaxing the matrix later is a product decision recorded here.
 *
 * S01 owns this file. Each later spec appends its keys in its own clearly
 * delimited block (see the "Spec Sxx" comments below).
 *
 * @module lib/gateway/capabilities
 */

/**
 * Maps a capability key to the protocols that support it.
 * @type {Record<string, Array<"REST" | "HTTP" | "WEBSOCKET">>}
 */
export const CAPABILITIES = {
  // --- Spec S01: routing, integration, auth, usage, deploy, processing, edge, observability ---
  "routing.resources": ["REST"],
  "routing.routes": ["HTTP"],
  "routing.websocket": ["WEBSOCKET"],
  "integration.http": ["REST", "HTTP", "WEBSOCKET"],
  "integration.httpCustom": ["REST", "WEBSOCKET"],
  "integration.mock": ["REST", "WEBSOCKET"],
  "integration.function": ["REST", "HTTP", "WEBSOCKET"],
  "auth.jwt": ["REST", "HTTP"],
  "auth.custom": ["REST", "HTTP", "WEBSOCKET"],
  "auth.signed": ["REST", "HTTP", "WEBSOCKET"],
  "auth.resourcePolicy": ["REST"],
  "usage.apiKeys": ["REST", "WEBSOCKET"],
  "usage.plans": ["REST", "WEBSOCKET"],
  "deploy.auto": ["HTTP"],
  "deploy.canary": ["REST"],
  cache: ["REST"],
  streaming: ["REST"],
  validation: ["REST", "WEBSOCKET"],
  templates: ["REST", "WEBSOCKET"],
  "mapping.params": ["REST", "HTTP"],
  "gatewayResponses.custom": ["REST"],
  waf: ["REST"],
  "endpoint.private": ["REST"],
  "endpoint.edge": ["REST"],
  "logs.execution": ["REST", "WEBSOCKET"],
  tracing: ["REST"],
  portal: ["REST"],
  "docs.parts": ["REST"],
  sdk: ["REST"],
  testInvoke: ["REST"],
  mtls: ["REST", "HTTP"],
  backendClientCert: ["REST"],
  routingRules: ["REST"],
  // --- End S01 block. Later specs append their own blocks below. ---
  // --- Spec S06: request/response processing ---
  "cors.managed": ["HTTP"],
  "processing.binary": ["REST"],
  "processing.compression": ["REST"],
  // --- End S06 block. ---
  // --- Spec S04: integrations ---
  "integration.awsService": ["REST", "HTTP", "WEBSOCKET"],
  "integration.connector": ["REST", "HTTP", "WEBSOCKET"],
  // --- End S04 block. ---
  // --- Spec S10: observability (metrics detail toggle, access logs, alarms, export) ---
  "metrics.detailed": ["REST", "HTTP", "WEBSOCKET"],
  "logs.access": ["REST", "HTTP", "WEBSOCKET"],
  "alarms": ["REST", "HTTP", "WEBSOCKET"],
  "logs.export": ["REST", "HTTP", "WEBSOCKET"],
  // --- End S10 block. ---
};

/**
 * Returns true when `protocol` supports capability `key`.
 * Unknown keys return false (fail closed).
 *
 * @param {string} protocol - `REST`, `HTTP` or `WEBSOCKET`.
 * @param {string} key - Capability key, e.g. `"usage.apiKeys"`.
 * @returns {boolean}
 */
export function supports(protocol, key) {
  if (typeof key !== "string" || !Object.hasOwn(CAPABILITIES, key)) return false;
  const entry = CAPABILITIES[key];
  return Array.isArray(entry) && entry.includes(protocol);
}
