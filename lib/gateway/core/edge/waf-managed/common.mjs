/**
 * PodsCommonRuleSet (S11 §D3): size limits, path traversal, LFI/RFI, bad
 * user agents, EC2-metadata SSRF strings. Stable rule names for exclusion.
 *
 * @module lib/gateway/core/edge/waf-managed/common
 */

export const PodsCommonRuleSet = {
  name: "PodsCommonRuleSet",
  version: "1.0",
  rules: [
    {
      name: "CommonRule_BodySize",
      action: "BLOCK",
      statement: {
        type: "SizeConstraintStatement",
        fieldToMatch: { Body: {} },
        comparisonOperator: "GT",
        size: 8 * 1024,
      },
    },
    {
      name: "CommonRule_Traversal",
      action: "BLOCK",
      statement: {
        type: "ByteMatchStatement",
        fieldToMatch: { UriPath: {} },
        positionalConstraint: "CONTAINS",
        searchString: "../",
        textTransformations: ["URL_DECODE", "NORMALIZE_PATH", "NONE"],
      },
    },
    {
      name: "CommonRule_Lfi",
      action: "BLOCK",
      statement: {
        type: "RegexMatchStatement",
        fieldToMatch: { AllQueryArguments: {} },
        regexString: "(etc/passwd|etc/shadow|\\.\\.[/\\\\]|file://|php://)",
        textTransformations: ["URL_DECODE", "LOWERCASE"],
      },
    },
    {
      name: "CommonRule_SsrfMetadata",
      action: "BLOCK",
      statement: {
        type: "ByteMatchStatement",
        fieldToMatch: { AllQueryArguments: {} },
        positionalConstraint: "CONTAINS",
        searchString: "169.254.169.254",
        textTransformations: ["URL_DECODE"],
      },
    },
    {
      name: "CommonRule_BadUserAgent",
      action: "BLOCK",
      statement: {
        type: "RegexMatchStatement",
        fieldToMatch: { SingleHeader: { name: "user-agent" } },
        regexString: "(nikto|sqlmap|masscan|nmap|dirbuster|hydra|medusa)",
        textTransformations: ["LOWERCASE"],
      },
    },
  ],
};
