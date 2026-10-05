/**
 * Mapping-template entry point (spec §5): parse at deploy, evaluate per
 * request. Exposes `parseTemplate`, `renderTemplate` and the `$input`/`$util`
 * host objects, plus `compileTemplates` for the S05 deploy step.
 *
 * Built-ins: `$input.body`, `$input.json(path)`, `$input.path(path)`,
 * `$input.params()` / `$input.params(name)`, `$util.escapeJavaScript`,
 * `$util.parseJson`, `$util.urlEncode`, `$util.urlDecode`,
 * `$util.base64Encode`, `$util.base64Decode`, `$context.*` (with writable
 * `$context.requestOverride.*` / `$context.responseOverride.*`),
 * `$stageVariables.*`.
 *
 * @module lib/gateway/core/processing/templates/index
 */

import { tokenize } from "./tokenizer.mjs";
import { parseTokens, TemplateSyntaxError } from "./parser.mjs";
import { renderAst, TemplateRenderError, TemplateLimitError } from "./interpreter.mjs";
import { evaluateJsonPath } from "../jsonpath.mjs";

export { TemplateSyntaxError } from "./parser.mjs";
export { TemplateRenderError, TemplateLimitError, isTruthy } from "./interpreter.mjs";
export { tokenize } from "./tokenizer.mjs";
export { parseTokens, parseExpression, parseReference } from "./parser.mjs";

/**
 * Parses a template into an AST (deploy time). Throws TemplateSyntaxError.
 *
 * @param {string} template
 * @returns {{ type: string, body: Array<object> }}
 */
export function parseTemplate(template) {
  return parseTokens(tokenize(template));
}

/**
 * Compiles a content-type → template table for a deployment.
 *
 * @param {Record<string,string>} [templates={}]
 * @returns {{ compiled: Map<string, object>, errors: Array<string> }}
 */
export function compileTemplates(templates = {}) {
  const compiled = new Map();
  const errors = [];
  for (const [contentType, template] of Object.entries(templates ?? {})) {
    try {
      compiled.set(contentType, parseTemplate(template));
    } catch (error) {
      errors.push(`${contentType}: ${error.message}`);
    }
  }
  return { compiled, errors };
}

function parseBodyJson(bodyText) {
  if (typeof bodyText !== "string" || bodyText.trim() === "") return null;
  try {
    return JSON.parse(bodyText);
  } catch {
    return null;
  }
}

function selectPath(root, path) {
  if (typeof path !== "string" || path.length === 0) return undefined;
  return evaluateJsonPath(root, path, { allowRecursive: true, allowFilter: true });
}

/**
 * Builds the `$input` host object for one request.
 *
 * @param {{ bodyText?: string, headers?: object, querystring?: object, pathParams?: object }} [request={}]
 * @returns {object}
 */
export function buildInput(request = {}) {
  const headers = request.headers ?? {};
  const querystring = request.querystring ?? {};
  const pathParams = request.pathParams ?? {};
  return {
    body: request.bodyText ?? "",
    json(path) {
      const root = parseBodyJson(request.bodyText ?? "");
      if (root === null) return "";
      const selected = path === undefined ? root : selectPath(root, path);
      if (selected === undefined) return "";
      return JSON.stringify(selected);
    },
    path(path) {
      const root = parseBodyJson(request.bodyText ?? "");
      if (root === null) return null;
      if (path === undefined) return root;
      const selected = selectPath(root, path);
      return selected === undefined ? null : selected;
    },
    params(name) {
      const params = { header: { ...headers }, querystring: { ...querystring }, path: { ...pathParams } };
      if (name === undefined) return params;
      const key = String(name);
      if (key === "__proto__" || key === "constructor" || key === "prototype") return "";
      if (Object.hasOwn(pathParams, key)) return pathParams[key];
      if (Object.hasOwn(querystring, key)) return querystring[key];
      const lower = key.toLowerCase();
      for (const headerName of Object.keys(headers)) {
        if (headerName.toLowerCase() === lower) return headers[headerName];
      }
      return "";
    },
  };
}

/** `$util` host object (spec §5). */
export function buildUtil() {
  return {
    escapeJavaScript(value) {
      return String(value ?? "")
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/'/g, "\\'")
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t")
        .replace(/\f/g, "\\f")
        .replace(/\x08/g, "\\b")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
    },
    parseJson(value) {
      try {
        return JSON.parse(String(value ?? ""));
      } catch (error) {
        throw new TemplateRenderError(`$util.parseJson: invalid JSON (${error.message})`);
      }
    },
    urlEncode(value) {
      return encodeURIComponent(String(value ?? ""));
    },
    urlDecode(value) {
      try {
        return decodeURIComponent(String(value ?? ""));
      } catch (error) {
        throw new TemplateRenderError(`$util.urlDecode: invalid encoding (${error.message})`);
      }
    },
    base64Encode(value) {
      return Buffer.from(String(value ?? ""), "utf8").toString("base64");
    },
    base64Decode(value) {
      try {
        return Buffer.from(String(value ?? ""), "base64").toString("utf8");
      } catch (error) {
        throw new TemplateRenderError(`$util.base64Decode: invalid base64 (${error.message})`);
      }
    },
  };
}

/**
 * Fresh `$context` overlay for template evaluation: the caller's context
 * object plus writable `requestOverride` / `responseOverride` maps.
 *
 * @param {object} [context={}]
 * @returns {object}
 */
export function buildTemplateContext(context = {}) {
  const overlay = { ...(context ?? {}) };
  overlay.requestOverride = { header: {}, querystring: {}, path: {} };
  overlay.responseOverride = { status: null, header: {} };
  return overlay;
}

/**
 * Renders a template string (or pre-parsed AST) for one request.
 *
 * @param {string|object} templateOrAst
 * @param {{ bodyText?: string, headers?: object, querystring?: object, pathParams?: object, context?: object, stageVariables?: object }} [request={}]
 * @returns {{ output: string, context: object }} output plus the context
 *   overlay (read `requestOverride` / `responseOverride` from it).
 */
export function renderTemplate(templateOrAst, request = {}) {
  const ast = typeof templateOrAst === "string" ? parseTemplate(templateOrAst) : templateOrAst;
  const context = buildTemplateContext(request.context ?? {});
  const output = renderAst(ast, {
    input: buildInput(request),
    util: buildUtil(),
    context,
    stageVariables: request.stageVariables ?? {},
  });
  return { output, context };
}
