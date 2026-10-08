/**
 * PodsSQLiRuleSet (S11 §D3): SQL injection across path, query, body and
 * JSON bodies at HIGH sensitivity.
 *
 * @module lib/gateway/core/edge/waf-managed/sqli
 */

const FIELDS = [
  { UriPath: {} },
  { QueryString: {} },
  { AllQueryArguments: {} },
  { Body: {} },
  { JsonBody: { matchScope: "ALL" } },
];

export const PodsSQLiRuleSet = {
  name: "PodsSQLiRuleSet",
  version: "1.0",
  rules: FIELDS.map((fieldToMatch, index) => ({
    name: `SqliRule_Field${index}`,
    action: "BLOCK",
    statement: {
      type: "SqliMatchStatement",
      fieldToMatch,
      sensitivityLevel: "HIGH",
      textTransformations: ["URL_DECODE", "HTML_ENTITY_DECODE"],
    },
  })),
};
