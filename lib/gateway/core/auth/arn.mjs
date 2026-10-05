/**
 * Method ARN helpers (S07 §2).
 *
 * Pods emits the same shape as AWS Lambda authorizers expect so existing
 * authorizer code that splits on `:` and `/` keeps working:
 * `arn:pods:execute-api:{region}:{projectId}:{apiPublicId}/{stage}/{METHOD}/{resourcePath}`.
 * Policies also accept the `arn:aws:execute-api:` prefix as an alias.
 *
 * `buildMethodArn` is re-exported from `policy.mjs` (single implementation;
 * the barrel `index.mjs` would otherwise see ambiguous star exports).
 *
 * @module lib/gateway/core/auth/arn
 */

export { buildMethodArn, credentialPrincipalArn } from "./policy.mjs";

/**
 * Parses a method ARN (pods or aws prefix) into its parts. Returns null when
 * the shape is not a method ARN.
 *
 * @param {string} arn
 * @returns {{ partition: string, region: string, projectId: string, apiPublicId: string, stage: string, method: string, resourcePath: string }|null}
 */
export function parseMethodArn(arn) {
  if (typeof arn !== "string") return null;
  const match = arn.match(/^arn:(pods|aws):execute-api:([^:]*):([^:]*):([^/]*)\/([^/]*)\/([^/]*)\/(.*)$/);
  if (!match) return null;
  const [, partition, region, projectId, apiPublicId, stage, method, resourcePath] = match;
  return { partition, region, projectId, apiPublicId, stage, method, resourcePath };
}

/**
 * IAM-semantics wildcard match: `*` matches any run of characters,
 * `?` matches exactly one character. The full string must match.
 *
 * @param {string} pattern - May contain `*` and `?`.
 * @param {string} value
 * @returns {boolean}
 */
export function wildcardMatch(pattern, value) {
  const text = String(pattern ?? "");
  const target = String(value ?? "");
  let regex = "";
  for (const char of text) {
    if (char === "*") regex += ".*";
    else if (char === "?") regex += ".";
    else if ("\\.+*?()|[]{}^$".includes(char)) regex += `\\${char}`;
    else regex += char;
  }
  return new RegExp(`^${regex}$`).test(target);
}
