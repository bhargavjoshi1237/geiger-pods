/**
 * PodsAdminProtectionRuleSet (S11 §D3): `/admin` path protection.
 *
 * @module lib/gateway/core/edge/waf-managed/admin
 */

export const PodsAdminProtectionRuleSet = {
  name: "PodsAdminProtectionRuleSet",
  version: "1.0",
  rules: [
    {
      name: "AdminRule_Path",
      action: "BLOCK",
      statement: {
        type: "ByteMatchStatement",
        fieldToMatch: { UriPath: {} },
        positionalConstraint: "STARTS_WITH",
        searchString: "/admin",
        textTransformations: ["URL_DECODE", "LOWERCASE", "NORMALIZE_PATH"],
      },
    },
    {
      name: "AdminRule_WpLogin",
      action: "BLOCK",
      statement: {
        type: "RegexMatchStatement",
        fieldToMatch: { UriPath: {} },
        regexString: "(wp-login|\\.env|\\.git/config|server-status)",
        textTransformations: ["URL_DECODE", "LOWERCASE"],
      },
    },
  ],
};
