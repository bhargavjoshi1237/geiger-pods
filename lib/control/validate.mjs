// Tiny schema validator for management API input (S02 §4). Plain descriptors,
// no new dependencies. Throws HttpError 422 on the first problem set.

import { HttpError } from "./errors.mjs";

function descriptor(kind, options = {}) {
  return { kind, ...options };
}

export function string(options = {}) {
  return descriptor("string", { min: options.min ?? null, max: options.max ?? null, pattern: options.pattern ?? null });
}

export function int(options = {}) {
  return descriptor("int", { min: options.min ?? null, max: options.max ?? null });
}

export function enumOf(values) {
  return descriptor("enum", { values: [...values] });
}

export function array(item, options = {}) {
  return descriptor("array", { item, min: options.min ?? null, max: options.max ?? null });
}

export function object(shape, options = {}) {
  return descriptor("object", { shape: { ...shape }, name: options.name ?? "body" });
}

export function optional(inner) {
  return descriptor("optional", { inner });
}

// `v.enum([...])` reads better at call sites; `enum` is only reserved as an
// export name, not as an object property.
export const v = { string, int, enum: enumOf, array, object, optional };

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function check(descriptorNode, value, path, errors) {
  if (descriptorNode.kind === "optional") {
    if (value === undefined) return undefined;
    return check(descriptorNode.inner, value, path, errors);
  }
  if (descriptorNode.kind === "string") {
    if (typeof value !== "string") {
      errors.push(`${path}: expected a string`);
      return undefined;
    }
    if (descriptorNode.min !== null && value.length < descriptorNode.min) errors.push(`${path}: must be at least ${descriptorNode.min} characters`);
    if (descriptorNode.max !== null && value.length > descriptorNode.max) errors.push(`${path}: must be at most ${descriptorNode.max} characters`);
    if (descriptorNode.pattern !== null && !(descriptorNode.pattern instanceof RegExp ? descriptorNode.pattern : new RegExp(descriptorNode.pattern)).test(value)) {
      errors.push(`${path}: has an invalid format`);
    }
    return value;
  }
  if (descriptorNode.kind === "int") {
    if (!Number.isInteger(value)) {
      errors.push(`${path}: expected an integer`);
      return undefined;
    }
    if (descriptorNode.min !== null && value < descriptorNode.min) errors.push(`${path}: must be >= ${descriptorNode.min}`);
    if (descriptorNode.max !== null && value > descriptorNode.max) errors.push(`${path}: must be <= ${descriptorNode.max}`);
    return value;
  }
  if (descriptorNode.kind === "enum") {
    if (!descriptorNode.values.includes(value)) errors.push(`${path}: must be one of ${descriptorNode.values.join(", ")}`);
    return value;
  }
  if (descriptorNode.kind === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected an array`);
      return undefined;
    }
    if (descriptorNode.min !== null && value.length < descriptorNode.min) errors.push(`${path}: must have at least ${descriptorNode.min} items`);
    if (descriptorNode.max !== null && value.length > descriptorNode.max) errors.push(`${path}: must have at most ${descriptorNode.max} items`);
    return value.map((entry, index) => check(descriptorNode.item, entry, `${path}[${index}]`, errors));
  }
  if (descriptorNode.kind === "object") {
    if (!isPlainObject(value)) {
      errors.push(`${path}: expected an object`);
      return undefined;
    }
    const out = {};
    for (const key of Object.keys(descriptorNode.shape)) {
      const field = descriptorNode.shape[key];
      if (value[key] === undefined && field.kind === "optional") continue;
      const checked = check(field, value[key], `${path}.${key}`, errors);
      if (value[key] !== undefined) out[key] = checked;
    }
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(descriptorNode.shape, key)) errors.push(`${path}.${key}: unknown field`);
    }
    return out;
  }
  errors.push(`${path}: unknown validator`);
  return undefined;
}

/**
 * Validate input against a schema built with `v.*`.
 * @returns the sanitized copy.
 * @throws {HttpError} 422 invalid_input with an `errors` list. Unknown fields
 * are rejected so misspelled keys cannot vanish silently.
 */
export function validate(schema, input) {
  const errors = [];
  const value = check(schema, input, "$", errors);
  if (errors.length > 0) {
    throw new HttpError(422, "invalid_input", `Invalid request: ${errors[0]}`, { errors });
  }
  return value;
}
