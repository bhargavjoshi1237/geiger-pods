/**
 * `waf` phase (pipeline row 4).
 * S01 stub: no-op. Owned by S11; that spec replaces the body,
 * keeping the exported `name` and `run(ctx)` contract.
 *
 * @module lib/gateway/core/phases/waf
 */

/** Phase name as listed in the pipeline table (§3). */
export const name = "waf";

/**
 * No-op stub: always returns `undefined` so the pipeline continues.
 *
 * @param {object} _ctx - Pipeline context.
 * @returns {Promise<undefined>}
 */
export async function run(_ctx) {
  return undefined;
}
