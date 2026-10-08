/**
 * PodsKnownBadInputsRuleSet (S11 §D3): Log4j JNDI, Java deserialization,
 * host-header localhost and XSS across inputs.
 *
 * @module lib/gateway/core/edge/waf-managed/bad-inputs
 */

export const PodsKnownBadInputsRuleSet = {
  name: "PodsKnownBadInputsRuleSet",
  version: "1.0",
  rules: [
    {
      name: "BadInput_Log4j",
      action: "BLOCK",
      statement: {
        type: "RegexMatchStatement",
        fieldToMatch: { Headers: {} },
        regexString: "\\$\\{jndi:(ldap|rmi|dns|iiop|corba|nis|nds)",
        textTransformations: ["URL_DECODE", "LOWERCASE"],
      },
    },
    {
      name: "BadInput_JavaDeserialization",
      action: "BLOCK",
      statement: {
        type: "RegexMatchStatement",
        fieldToMatch: { Body: {} },
        regexString: "(java\\.lang\\.|java\\.util\\.|org\\.apache\\.commons\\.collections|serialVersionUID|rO0AB)",
        textTransformations: ["NONE"],
      },
    },
    {
      name: "BadInput_LocalhostHost",
      action: "BLOCK",
      statement: {
        type: "RegexMatchStatement",
        fieldToMatch: { SingleHeader: { name: "host" } },
        regexString: "^(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\])(:[0-9]+)?$",
        textTransformations: ["LOWERCASE"],
      },
    },
    {
      name: "BadInput_XssQuery",
      action: "BLOCK",
      statement: {
        type: "XssMatchStatement",
        fieldToMatch: { AllQueryArguments: {} },
        textTransformations: ["URL_DECODE", "HTML_ENTITY_DECODE"],
      },
    },
    {
      name: "BadInput_XssBody",
      action: "BLOCK",
      statement: {
        type: "XssMatchStatement",
        fieldToMatch: { Body: {} },
        textTransformations: ["URL_DECODE", "HTML_ENTITY_DECODE"],
      },
    },
  ],
};
