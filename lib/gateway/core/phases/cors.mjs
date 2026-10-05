/**
 * `cors` phase (pipeline row 6 — managed preflight before auth).
 *
 * S06W implementation (replaces the S01 no-op stub, keeping the `name` +
 * `run(ctx)` contract). For HTTP APIs with a managed CORS config
 * (`artifact.settings.cors`), answers preflight requests (`OPTIONS` + `Origin`
 * + `Access-Control-Request-Method`) directly with 204: no authorizer, no
 * integration and no OPTIONS route needed. A non-preflight `OPTIONS` goes
 * through normal routing. Actual-response CORS headers are applied in the
 * `methodResponse` phase (and to gateway errors by the pipeline renderer),
 * replacing backend CORS headers per AWS.
 *
 * NOTE: the preflight short-circuit for requests without a matching route
 * lives in `runPipeline` (`lib/gateway/core/pipeline.mjs`), because `match`
 * (row 5) runs before this phase and would otherwise 404. This phase handles
 * preflights that survived matching (i.e. an OPTIONS route exists) so the
 * behavior is identical either way.
 *
 * @module lib/gateway/core/phases/cors
 */

import { handlePreflight } from "../processing/cors.mjs";

/** Phase name as listed in the pipeline table (§3). */
export const name = "cors";

/**
 * Answers managed HTTP preflights with 204.
 *
 * @param {object} ctx - Pipeline context.
 * @returns {Promise<Response|undefined>} 204 on preflight, else `undefined`.
 */
export async function run(ctx) {
  const artifact = ctx?.artifact ?? {};
  if ((artifact.protocol ?? "REST") !== "HTTP") return undefined;
  const cors = artifact.settings?.cors ?? null;
  if (!cors) return undefined;
  const answer = handlePreflight(ctx.request, cors, { features: artifact.features ?? {} });
  if (answer) ctx.corsPreflight = true;
  return answer ?? undefined;
}
