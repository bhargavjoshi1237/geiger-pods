/**
 * Control-plane limit enforcement (S15 §1).
 *
 * Wraps the pure `lib/gateway/core/limits.mjs` table with `HttpError`
 * throws (`409 limit_exceeded { limit, value }` for count caps, `422` for
 * size/shape caps). Services call `assertCountWithinLimit` before inserting
 * the (count+1)th row; overrides come from
 * `project_settings.features.limits` (staff-set via SQL).
 *
 * @module lib/control/limits
 */

import { HttpError } from "./errors.mjs";
import { exceedsCountLimit, getLimit } from "../gateway/core/limits.mjs";

/**
 * Throws `409 limit_exceeded` when `count` already reaches the limit.
 *
 * @param {string} key - `LIMIT_TABLE` key.
 * @param {number} count - Existing count.
 * @param {Record<string,number>} [overrides={}]
 */
export function assertCountWithinLimit(key, count, overrides = {}) {
  if (exceedsCountLimit(key, count, overrides)) {
    const limit = getLimit(key, overrides);
    throw new HttpError(409, "limit_exceeded", `Limit exceeded: ${key} allows ${limit}.`, { limit: key, value: limit });
  }
}

/**
 * Throws `422 limit_exceeded` when `size` exceeds a byte/char cap.
 *
 * @param {string} key
 * @param {number} size
 * @param {Record<string,number>} [overrides={}]
 */
export function assertSizeWithinLimit(key, size, overrides = {}) {
  if (exceedsCountLimit(key, size, overrides)) {
    const limit = getLimit(key, overrides);
    throw new HttpError(422, "limit_exceeded", `Limit exceeded: ${key} allows ${limit}.`, { limit: key, value: limit });
  }
}

export { exceedsCountLimit, getLimit };
