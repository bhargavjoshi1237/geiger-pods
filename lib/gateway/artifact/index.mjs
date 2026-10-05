/**
 * Artifact barrel (S05 §1).
 *
 * @module lib/gateway/artifact/index
 */

export { canonicalJson, sortKeys } from "./canonical.mjs";
export { validateStageVariables } from "./stage-variables.mjs";
export {
  compile,
  digestBody,
  SCHEMA_VERSION,
  setPlaintextCache,
  clearPlaintextCache,
} from "./compile.mjs";
