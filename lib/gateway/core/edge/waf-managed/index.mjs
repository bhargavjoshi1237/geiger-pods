/**
 * Managed rule group registry (S11 §D3).
 *
 * Versioned JSON-equivalent modules (kept as ESM so the engine stays
 * importable without JSON import attributes). Each rule has a stable name
 * for exclusion/override.
 *
 * @module lib/gateway/core/edge/waf-managed/index
 */

import { PodsCommonRuleSet } from "./common.mjs";
import { PodsSQLiRuleSet } from "./sqli.mjs";
import { PodsKnownBadInputsRuleSet } from "./bad-inputs.mjs";
import { PodsAdminProtectionRuleSet } from "./admin.mjs";

/** @type {Map<string, object>} */
export const MANAGED_RULE_GROUPS = new Map([
  [PodsCommonRuleSet.name, PodsCommonRuleSet],
  [PodsSQLiRuleSet.name, PodsSQLiRuleSet],
  [PodsKnownBadInputsRuleSet.name, PodsKnownBadInputsRuleSet],
  [PodsAdminProtectionRuleSet.name, PodsAdminProtectionRuleSet],
]);
