/**
 * S06 processing barrel: CORS, parameter mapping, models/validation,
 * mapping templates (VTL), integration/method responses, binary content,
 * compression and the compile-time validator S05 calls.
 *
 * Pure ES modules: input is data, output is data (or Web Response for CORS
 * preflight and compression helpers). No Next.js, Supabase or Node-only
 * APIs except `node:zlib` (compression) and `node:crypto`-free base64 via
 * Buffer — injected ports stay in the phase layer (S05 wiring).
 *
 * @module lib/gateway/core/processing/index
 */

export * from "./cors.mjs";
export * from "./param-mapping.mjs";
export * from "./jsonpath.mjs";
export * from "./validation.mjs";
export * from "./responses.mjs";
export * from "./content.mjs";
export * from "./compression.mjs";
export * from "./validate-processing.mjs";
export * as templates from "./templates/index.mjs";
