/**
 * Stage-variable validation (S05 §2, AWS character set).
 *
 * ≤100 entries; key `^[A-Za-z0-9_]{1,64}$`; value ≤512 chars from
 * `[A-Za-z0-9-._~:/?#&=,]` (the AWS set; empty values are allowed and
 * render as empty strings in URIs).
 *
 * @module lib/gateway/artifact/stage-variables
 */

const KEY_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
const VALUE_PATTERN = /^[A-Za-z0-9\-._~:/?#&=,]{0,512}$/;

/**
 * Validates a stage-variables table.
 *
 * @param {unknown} variables
 * @returns {{ errors: Array<object>, clean: Record<string, string> }}
 */
export function validateStageVariables(variables) {
  const errors = [];
  if (variables === undefined || variables === null) return { errors, clean: {} };
  if (typeof variables !== "object" || Array.isArray(variables)) {
    return { errors: [{ path: "variables", message: "Stage variables must be an object.", code: "invalid_variables" }], clean: {} };
  }
  const entries = Object.entries(variables);
  if (entries.length > 100) {
    errors.push({ path: "variables", message: "Stage variables must have at most 100 entries.", code: "too_many_variables" });
  }
  const clean = {};
  for (const [key, value] of entries) {
    if (!KEY_PATTERN.test(key)) {
      errors.push({ path: `variables.${key}`, message: `Invalid stage variable name "${key}".`, code: "invalid_variable_name" });
      continue;
    }
    const text = String(value ?? "");
    if (text.length > 512 || !VALUE_PATTERN.test(text)) {
      errors.push({ path: `variables.${key}`, message: `Invalid stage variable value for "${key}".`, code: "invalid_variable_value" });
      continue;
    }
    clean[key] = text;
  }
  return { errors, clean };
}
