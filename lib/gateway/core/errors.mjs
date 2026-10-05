/**
 * Gateway errors. A thrown `GatewayError` short-circuits the pipeline
 * to a gateway response (§5 of the architecture spec).
 *
 * @module lib/gateway/core/errors
 */

import { GATEWAY_RESPONSES } from "./gateway-responses.mjs";

/**
 * Error thrown by pipeline phases to produce a gateway response.
 * `type` is one of the `GATEWAY_RESPONSES` keys; `message` defaults to
 * the catalog message; `extra` carries details (e.g. validation errors).
 */
export class GatewayError extends Error {
  /**
   * @param {string} type - Gateway response type, e.g. `"THROTTLED"`.
   * @param {string} [message] - Defaults to the catalog message for `type`.
   * @param {Record<string, unknown>} [extra] - Additional detail payload.
   */
  constructor(type, message, extra) {
    if (typeof type !== "string" || !Object.hasOwn(GATEWAY_RESPONSES, type)) {
      throw new TypeError(`Unknown gateway response type: ${type}`);
    }
    const entry = GATEWAY_RESPONSES[type];
    super(message ?? entry.message);
    this.name = "GatewayError";
    this.type = type;
    this.statusCode = entry.status ?? (type === "DEFAULT_4XX" ? 400 : 500);
    this.extra = extra ?? {};
  }
}

/**
 * Narrows an unknown value to `GatewayError`.
 *
 * @param {unknown} err
 * @returns {err is GatewayError}
 */
export function isGatewayError(err) {
  return err instanceof GatewayError;
}
