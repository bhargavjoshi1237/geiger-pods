/**
 * `canary` phase (pipeline row 7 — pick canary or base deployment).
 * S01 stub: no-op. Owned by S09; that spec replaces the body,
 * keeping the exported `name` and `run(ctx)` contract.
 *
 * @module lib/gateway/core/phases/canary
 */

/** Phase name as listed in the pipeline table (§3). */
export const name = "canary";

/**
 * No-op stub: always returns `undefined` so the pipeline continues.
 *
 * @param {object} _ctx - Pipeline context.
 * @returns {Promise<undefined>}
 */
export async function run(_ctx) {
  return undefined;
}
