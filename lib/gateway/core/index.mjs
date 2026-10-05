/**
 * Engine entry point: `handle(request, artifact, ports) -> Response`.
 *
 * Input is a Web `Request` plus a compiled (immutable, secret-free)
 * deployment artifact; output is a Web `Response`. With the S01 no-op
 * stubs, an unmatched request returns `MISSING_AUTHENTICATION_TOKEN`
 * for REST and 404 for HTTP (AWS behavior for unknown routes); later
 * specs fill in the phases that produce real responses.
 *
 * @module lib/gateway/core/index
 */

import { buildContext } from "./context.mjs";
import { runPipeline } from "./pipeline.mjs";
import { MemoryKvStore } from "../state/memory-kv.mjs";

/**
 * Merges partial ports over safe defaults (memory KV on the given clock,
 * global `fetch`, throwing secret resolver, no-op event sink and log).
 *
 * @param {Partial<import("./ports.mjs").Ports>} [partial={}]
 * @returns {import("./ports.mjs").Ports}
 */
export function createPorts(partial = {}) {
  const clock = partial.clock ?? { now: () => Date.now() };
  const ports = {
    fetch: partial.fetch ?? globalThis.fetch,
    kv: partial.kv ?? new MemoryKvStore({ clock }),
    secrets:
      partial.secrets ??
      {
        async resolve(ref) {
          throw new Error(`No secret resolver configured (ref: ${ref})`);
        },
      },
    events: partial.events ?? { emit() {} },
    clock,
    log: partial.log ?? (() => {}),
  };
  // S07 additive: signing-credential ports ride along when provided (the
  // `authorize` phase reads them); any other extra keys pass through too so
  // future specs need no change here.
  for (const [key, value] of Object.entries(partial ?? {})) {
    if (!(key in ports) && value !== undefined) ports[key] = value;
  }
  return ports;
}

/**
 * Handles one gateway request against a compiled artifact.
 *
 * @param {Request} request - Incoming Web request.
 * @param {object} [artifact={}] - Compiled deployment artifact (read-only).
 * @param {Partial<import("./ports.mjs").Ports>} [ports={}] - Injected ports.
 * @returns {Promise<Response>}
 */
export async function handle(request, artifact = {}, ports = {}) {
  const full = createPorts(ports);
  const ctx = buildContext(request, artifact, full);
  return runPipeline(ctx);
}

export { buildContext } from "./context.mjs";
export { runPipeline, runPhases } from "./pipeline.mjs";
export { PHASES, PHASE_ORDER } from "./phases/index.mjs";
