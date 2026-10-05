/**
 * Canary release selection (S09 §1).
 *
 * Pure helpers for the `canary` pipeline phase (row 7). The RNG is injected
 * (`ports.rng`, `ctx.rng`, or `Math.random`) so tests seed it. Sticky
 * assignment (Pods extension, off by default) hashes a header/cookie value
 * into a stable 0–100 bucket.
 *
 * @module lib/gateway/core/release/canary
 */

import { createHash } from "node:crypto";

/**
 * Draws a uniform 0–100 value from `rng()` and routes to canary when below
 * `percentTraffic`.
 *
 * @param {number} percentTraffic - 0.0–100.0.
 * @param {() => number} [rng=Math.random] - Returns [0, 1).
 * @returns {boolean}
 */
export function pickCanary(percentTraffic, rng = Math.random) {
  const percent = Number(percentTraffic);
  if (!(percent > 0)) return false;
  if (percent >= 100) return true;
  const draw = Number(rng()) * 100;
  return draw < percent;
}

/**
 * Hashes a sticky value into a stable 0–100 bucket.
 *
 * @param {string} value
 * @returns {number} Bucket in [0, 100).
 */
export function hashSticky(value) {
  const digest = createHash("sha256").update(String(value ?? ""), "utf8").digest();
  const int = digest.readUInt32BE(0);
  return (int / 0xffffffff) * 100;
}

/**
 * Reads the sticky value from the request (header or cookie).
 *
 * @param {Request} request
 * @param {{ source: string, name: string }} sticky
 * @returns {string|null}
 */
export function stickyValueFor(request, sticky) {
  if (!sticky || typeof sticky.name !== "string" || sticky.name === "") return null;
  try {
    if (sticky.source === "header") {
      const value = request.headers.get(sticky.name);
      return value === null ? null : String(value);
    }
    if (sticky.source === "cookie") {
      const cookie = request.headers.get("cookie") ?? "";
      const prefix = `${sticky.name}=`;
      for (const part of String(cookie).split(";")) {
        const trimmed = part.trim();
        if (trimmed.startsWith(prefix)) {
          return decodeURIComponent(trimmed.slice(prefix.length));
        }
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Decides whether this request goes to the canary deployment.
 *
 * Sticky (when configured and a value is present) wins over the RNG so the
 * same client sticks to one side.
 *
 * @param {{ canary?: object|null, request: Request, rng?: () => number }} options
 * @returns {boolean}
 */
export function shouldRouteToCanary({ canary, request, rng = Math.random } = {}) {
  if (!canary) return false;
  const percent = Number(canary.percentTraffic ?? canary.percent_traffic ?? 0);
  if (!(percent > 0)) return false;
  if (percent >= 100) return true;
  const sticky = canary.sticky ?? null;
  if (sticky && (sticky.source === "header" || sticky.source === "cookie") && request) {
    const value = stickyValueFor(request, sticky);
    if (value !== null && value !== "") {
      return hashSticky(`${sticky.source}:${sticky.name}:${value}`) < percent;
    }
  }
  return pickCanary(percent, rng);
}

/**
 * Merges canary stage-variable overrides over the base variables.
 *
 * @param {Record<string,string>} [base={}]
 * @param {Record<string,string>} [overrides={}]
 * @returns {Record<string,string>}
 */
export function mergeStageVariables(base = {}, overrides = {}) {
  return { ...(base ?? {}), ...(overrides ?? {}) };
}

/**
 * Validates a canary config for the control plane.
 *
 * @param {unknown} input
 * @returns {{ deploymentId: string|null, percentTraffic: number, stageVariableOverrides: Record<string,string>, useStageCache: boolean, sticky: object|null }}
 * @throws {Error} With `code` (`invalid_input`) on bad input.
 */
export function validateCanaryConfig(input) {
  const value = input ?? {};
  if (typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("Invalid request: $.canary: expected an object");
    error.code = "invalid_input";
    throw error;
  }
  const percent = Number(value.percentTraffic ?? value.percent_traffic ?? 0);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    const error = new Error("Invalid request: $.canary.percentTraffic: must be 0–100");
    error.code = "invalid_input";
    throw error;
  }
  // One decimal place (AWS).
  if (Math.round(percent * 10) !== percent * 10) {
    const error = new Error("Invalid request: $.canary.percentTraffic: at most one decimal place");
    error.code = "invalid_input";
    throw error;
  }
  const overrides = value.stageVariableOverrides ?? value.stage_variable_overrides ?? {};
  if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) {
    const error = new Error("Invalid request: $.canary.stageVariableOverrides: expected an object");
    error.code = "invalid_input";
    throw error;
  }
  let sticky = value.sticky ?? null;
  if (sticky !== null && sticky !== undefined) {
    if (typeof sticky !== "object" || Array.isArray(sticky)) {
      const error = new Error("Invalid request: $.canary.sticky: expected an object");
      error.code = "invalid_input";
      throw error;
    }
    if (sticky.source !== "header" && sticky.source !== "cookie") {
      const error = new Error("Invalid request: $.canary.sticky.source: must be header or cookie");
      error.code = "invalid_input";
      throw error;
    }
    if (typeof sticky.name !== "string" || sticky.name === "") {
      const error = new Error("Invalid request: $.canary.sticky.name: required");
      error.code = "invalid_input";
      throw error;
    }
  } else {
    sticky = null;
  }
  return {
    deploymentId: value.deploymentId ?? value.deployment_id ?? null,
    percentTraffic: percent,
    stageVariableOverrides: { ...overrides },
    useStageCache: Boolean(value.useStageCache ?? value.use_stage_cache ?? false),
    sticky,
  };
}
