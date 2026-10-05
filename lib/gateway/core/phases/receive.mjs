/**
 * `receive` phase (pipeline row 1 — request id, start time, limits).
 * S01 stub: no-op. Owned by S01/S15; that spec replaces the body,
 * keeping the exported `name` and `run(ctx)` contract.
 *
 * @module lib/gateway/core/phases/receive
 */

/** Phase name as listed in the pipeline table (§3). */
export const name = "receive";

/**
 * No-op stub: always returns `undefined` so the pipeline continues.
 *
 * @param {object} _ctx - Pipeline context.
 * @returns {Promise<undefined>}
 */
export async function run(_ctx) {
  return undefined;
}
