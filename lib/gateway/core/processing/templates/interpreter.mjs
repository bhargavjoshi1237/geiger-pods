/**
 * Interpreter for the S06 Velocity-compatible AST (spec §5).
 *
 * No `eval`/`Function`. Enforces the 1e6-step budget, the 1000-iteration
 * `#foreach` limit and the 10 MB output cap; exceeding any limit throws
 * `TemplateLimitError` (rendered as 500 `API_CONFIGURATION_ERROR`).
 * Prototype pollution is guarded: `__proto__`, `constructor` and
 * `prototype` are never read or written through template paths.
 *
 * @module lib/gateway/core/processing/templates/interpreter
 */

/** `#foreach` iterations per loop (AWS limit). */
export const MAX_FOREACH_ITERATIONS = 1000;

/** Largest `[a..b]` range that materializes (DoS guard; larger throws). */
export const MAX_RANGE_SIZE = 10000;

/** AST evaluations per render (spec §5 step budget). */
export const MAX_TEMPLATE_STEPS = 1e6;

/** Rendered output cap: 10 MB (spec §5). */
export const MAX_TEMPLATE_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Render-time failure (unknown method, bad JSON, limit exceeded, …). */
export class TemplateRenderError extends Error {
  constructor(message, code = "API_CONFIGURATION_ERROR") {
    super(message);
    this.name = "TemplateRenderError";
    this.code = code;
  }
}

/** Limit failure: step budget, foreach iterations or output size. */
export class TemplateLimitError extends TemplateRenderError {
  constructor(message) {
    super(message, "API_CONFIGURATION_ERROR");
    this.name = "TemplateLimitError";
  }
}

/** Marker for undefined-variable reads (falsy in conditions, null in #set). */
function undefinedVar(name) {
  const error = new TemplateRenderError(`Undefined variable: $${name}`);
  error.undefinedVariable = true;
  return error;
}

/** Evaluates an expression, mapping undefined variables to null. */
function softEvaluate(node, scope, state) {
  try {
    return evaluate(node, scope, state);
  } catch (error) {
    if (error instanceof TemplateRenderError && error.undefinedVariable) return null;
    throw error;
  }
}

class BreakSignal {}
class StopSignal {}

const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function blocked(key) {
  return typeof key === "string" && BLOCKED_KEYS.has(key);
}

/** Velocity-ish truthiness: empty string/list/map, 0, false and null are falsy. */
export function isTruthy(value) {
  if (value === false || value === null || value === undefined) return false;
  if (value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function toNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const num = Number(value);
  return Number.isFinite(num) ? num : NaN;
}

function looseEquals(left, right) {
  if (left === right) return true;
  if (typeof left === typeof right) return false;
  // Numeric strings compare numerically (`"2" == 2`), otherwise by string.
  if ((typeof left === "number" && typeof right === "string") || (typeof left === "string" && typeof right === "number")) {
    const l = toNumber(left);
    const r = toNumber(right);
    if (!Number.isNaN(l) && !Number.isNaN(r)) return l === r;
  }
  return String(left) === String(right);
}

// ---------------------------------------------------------------------------
// Java-ish method dispatch
// ---------------------------------------------------------------------------

function stringMethod(value, method, args) {
  switch (method) {
    case "length": return value.length;
    case "isEmpty": return value.length === 0;
    case "contains": return value.includes(String(args[0] ?? ""));
    case "startsWith": return value.startsWith(String(args[0] ?? ""));
    case "endsWith": return value.endsWith(String(args[0] ?? ""));
    case "indexOf": return value.indexOf(String(args[0] ?? ""));
    case "substring": {
      const start = toNumber(args[0]);
      const end = args.length > 1 ? toNumber(args[1]) : value.length;
      return value.substring(start, end);
    }
    case "replace": return value.split(String(args[0] ?? "")).join(String(args[1] ?? ""));
    case "replaceAll": return value.replace(new RegExp(String(args[0] ?? ""), "g"), String(args[1] ?? ""));
    case "split": return value.split(new RegExp(String(args[0] ?? "")));
    case "toLowerCase": return value.toLowerCase();
    case "toUpperCase": return value.toUpperCase();
    case "trim": return value.trim();
    case "equals": return value === String(args[0] ?? "");
    case "equalsIgnoreCase": return value.toLowerCase() === String(args[0] ?? "").toLowerCase();
    case "matches": return new RegExp(`^(?:${String(args[0] ?? "")})$`).test(value);
    case "toString": return value;
    default: return undefined;
  }
}

function listMethod(value, method, args) {
  switch (method) {
    case "size": return value.length;
    case "isEmpty": return value.length === 0;
    case "get": return value[toNumber(args[0])] ?? null;
    case "add": value.push(args[0] ?? null); return true;
    case "contains": return value.some((item) => looseEquals(item, args[0]));
    case "toString": return String(value);
    default: return undefined;
  }
}

function mapMethod(value, method, args) {
  switch (method) {
    case "get": return blocked(args[0]) ? null : (value[String(args[0])] ?? null);
    case "put": {
      const key = String(args[0] ?? "");
      if (blocked(key)) throw new TemplateRenderError(`Refusing to write reserved key "${key}"`);
      value[key] = args[1] ?? null;
      return args[1] ?? null;
    }
    case "keySet": return Object.keys(value);
    case "entrySet": return Object.entries(value).map(([key, entryValue]) => ({ key, value: entryValue }));
    case "containsKey": return !blocked(args[0]) && Object.hasOwn(value, String(args[0]));
    case "size": return Object.keys(value).length;
    case "isEmpty": return Object.keys(value).length === 0;
    case "toString": return String(value);
    default: return undefined;
  }
}

function callMethod(receiver, method, args) {
  if (receiver === null || receiver === undefined) return null;
  if (typeof receiver === "string") {
    const result = stringMethod(receiver, method, args);
    if (result === undefined) throw new TemplateRenderError(`Unknown String method: ${method}()`);
    return result;
  }
  if (Array.isArray(receiver)) {
    const result = listMethod(receiver, method, args);
    if (result === undefined) throw new TemplateRenderError(`Unknown List method: ${method}()`);
    return result;
  }
  if (typeof receiver === "object") {
    const result = mapMethod(receiver, method, args);
    if (result === undefined) throw new TemplateRenderError(`Unknown Map method: ${method}()`);
    return result;
  }
  if (typeof receiver === "number") {
    if (method === "toString") return String(receiver);
    throw new TemplateRenderError(`Unknown Number method: ${method}()`);
  }
  if (typeof receiver === "boolean") {
    if (method === "toString") return String(receiver);
    throw new TemplateRenderError(`Unknown Boolean method: ${method}()`);
  }
  throw new TemplateRenderError(`Cannot call ${method}() on ${typeof receiver}`);
}

function readProperty(receiver, key) {
  if (receiver === null || receiver === undefined) return { found: true, value: null };
  if (blocked(key)) return { found: false, value: undefined };
  if (Array.isArray(receiver)) {
    if (key === "length" || key === "size") return { found: true, value: receiver.length };
    if (typeof key === "number" || /^-?\d+$/.test(String(key))) {
      const index = Number(key) < 0 ? receiver.length + Number(key) : Number(key);
      return { found: true, value: receiver[index] ?? null };
    }
    return { found: false, value: undefined };
  }
  if (typeof receiver === "object") {
    if (typeof receiver[key] === "function" && !Object.hasOwn(receiver, key)) {
      // Host-object helper (e.g. a bound $input method reached via Get):
      // return it so Call can invoke it.
      return { found: true, value: receiver[key] };
    }
    if (Object.hasOwn(receiver, key) || key in Object(receiver)) {
      return { found: true, value: receiver[key] ?? null };
    }
    // Map-style access for null-prototype or plain template maps.
    return { found: false, value: undefined };
  }
  if (typeof receiver === "string") {
    if (key === "length") return { found: true, value: receiver.length };
    if (typeof key === "number" || /^-?\d+$/.test(String(key))) {
      return { found: true, value: receiver[Number(key)] ?? null };
    }
    return { found: false, value: undefined };
  }
  return { found: false, value: undefined };
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

class Scope {
  constructor(parent = null) {
    this.parent = parent;
    this.vars = new Map();
  }

  define(name, value) {
    this.vars.set(name, value);
  }

  lookup(name) {
    let scope = this;
    while (scope) {
      if (scope.vars.has(name)) return { found: true, value: scope.vars.get(name) };
      scope = scope.parent;
    }
    return { found: false, value: undefined };
  }

  assign(name, value) {
    let scope = this;
    while (scope) {
      if (scope.vars.has(name)) {
        scope.vars.set(name, value);
        return true;
      }
      scope = scope.parent;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------

/**
 * Renders a parsed template AST.
 *
 * @param {{ type: string, body?: Array<object> }} ast
 * @param {{ input?: object, util?: object, context?: object, stageVariables?: object }} [data={}]
 * @param {{ steps?: number }} [options]
 * @returns {string}
 */
export function renderAst(ast, data = {}, options = {}) {
  const state = {
    steps: 0,
    outputLength: 0,
    maxSteps: options.steps ?? MAX_TEMPLATE_STEPS,
  };
  const scope = new Scope();
  scope.define("input", data.input ?? {});
  scope.define("util", data.util ?? {});
  scope.define("context", data.context ?? {});
  scope.define("stageVariables", data.stageVariables ?? {});
  // `$velocityCount`/`$velocityHasNext` exist at top level during loops.
  let output = "";
  const append = (text) => {
    output += text;
    state.outputLength += Buffer.byteLength(text, "utf8");
    if (state.outputLength > MAX_TEMPLATE_OUTPUT_BYTES) {
      throw new TemplateLimitError(`Template output exceeds ${MAX_TEMPLATE_OUTPUT_BYTES} bytes`);
    }
  };
  try {
    renderBody(ast.body ?? [], scope, state, append, data);
  } catch (error) {
    if (error instanceof StopSignal) return output;
    throw error;
  }
  return output;
}

function tick(state) {
  state.steps += 1;
  if (state.steps > state.maxSteps) throw new TemplateLimitError(`Template step budget (${state.maxSteps}) exceeded`);
}

function renderBody(body, scope, state, append, data) {
  for (const node of body) {
    tick(state);
    renderNode(node, scope, state, append, data);
  }
}

function renderNode(node, scope, state, append, data) {
  switch (node.type) {
    case "Text":
      append(node.value);
      return;
    case "Ref": {
      const { found, value } = evaluateRef(node.expr, scope, state);
      if (!found) {
        append(node.quiet ? "" : node.raw);
        return;
      }
      append(stringify(value));
      return;
    }
    case "Set": {
      const value = softEvaluate(node.value, scope, state);
      assignTarget(node.target, value, scope, state);
      return;
    }
    case "If": {
      for (const branch of node.branches) {
        if (isTruthy(softEvaluate(branch.test, scope, state))) {
          renderBody(branch.body, new Scope(scope), state, append, data);
          return;
        }
      }
      if (node.elseBody) renderBody(node.elseBody, new Scope(scope), state, append, data);
      return;
    }
    case "Foreach": {
      const list = toIterable(softEvaluate(node.list, scope, state));
      if (list.length > MAX_FOREACH_ITERATIONS) {
        throw new TemplateLimitError(`#foreach exceeds ${MAX_FOREACH_ITERATIONS} iterations`);
      }
      const loopScope = new Scope(scope);
      for (let index = 0; index < list.length; index += 1) {
        tick(state);
        loopScope.define(node.item, list[index]);
        loopScope.define("foreach", {
          index,
          count: index + 1,
          hasNext: index + 1 < list.length,
        });
        loopScope.define("velocityCount", index + 1);
        loopScope.define("velocityHasNext", index + 1 < list.length);
        try {
          renderBody(node.body, new Scope(loopScope), state, append, data);
        } catch (error) {
          if (error instanceof BreakSignal) break;
          throw error;
        }
      }
      return;
    }
    case "Break":
      throw new BreakSignal();
    case "Stop":
      throw new StopSignal();
    default:
      throw new TemplateRenderError(`Unknown AST node: ${node.type}`);
  }
}

function toIterable(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return Object.values(value);
  return [value];
}

/**
 * Renders a value to template output text. Objects become JSON (AWS
 * `$input.path` selections stringify the same way).
 */
function stringify(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function evaluate(node, scope, state) {
  tick(state);
  switch (node.type) {
    case "Literal":
      return node.value;
    case "RefExpr":
      // Inside "…" interpolation: missing refs render empty when quiet,
      // literally otherwise (matching top-level Ref behavior).
      try {
        return stringify(evaluateRefInner(node.expr, scope, state));
      } catch (error) {
        if (error instanceof TemplateRenderError && (error.undefinedVariable || error.notFound)) {
          return missingRefText(node);
        }
        throw error;
      }
    case "Interpolated":
      return node.parts.map((part) => {
        if (part.type === "Literal") return part.value;
        try {
          return stringify(evaluateRefInner(part.expr, scope, state));
        } catch (error) {
          if (error instanceof TemplateRenderError && (error.undefinedVariable || error.notFound)) {
            return missingRefText(part);
          }
          throw error;
        }
      }).join("");
    case "Var": {
      const { found, value } = scope.lookup(node.name);
      if (!found) throw undefinedVar(node.name);
      return value ?? null;
    }
    case "Get": {
      const object = evaluate(node.object, scope, state);
      const key = evaluate(node.key, scope, state);
      return readProperty(object, key).value ?? null;
    }
    case "Call": {
      const object = evaluate(node.object, scope, state);
      const args = node.args.map((arg) => evaluate(arg, scope, state));
      if (object !== null && typeof object === "object" && typeof object[node.method] === "function" && !blocked(node.method)) {
        return object[node.method](...args) ?? null;
      }
      return callMethod(object, node.method, args);
    }
    case "Unary": {
      const arg = evaluate(node.arg, scope, state);
      if (node.op === "!") return !isTruthy(arg);
      return -toNumber(arg);
    }
    case "Binary": {
      const left = evaluate(node.left, scope, state);
      // Short-circuit logic operators.
      if (node.op === "&&") return isTruthy(left) ? evaluate(node.right, scope, state) : left;
      if (node.op === "||") return isTruthy(left) ? left : evaluate(node.right, scope, state);
      const right = evaluate(node.right, scope, state);
      switch (node.op) {
        case "==": return looseEquals(left, right);
        case "!=": return !looseEquals(left, right);
        case "<": return left < right;
        case ">": return left > right;
        case "<=": return left <= right;
        case ">=": return left >= right;
        case "+": return typeof left === "string" || typeof right === "string" ? String(left) + String(right) : toNumber(left) + toNumber(right);
        case "-": return toNumber(left) - toNumber(right);
        case "*": return toNumber(left) * toNumber(right);
        case "/": return toNumber(left) / toNumber(right);
        case "%": return toNumber(left) % toNumber(right);
        default: throw new TemplateRenderError(`Unknown operator: ${node.op}`);
      }
    }
    case "List":
      return node.items.map((item) => evaluate(item, scope, state));
    case "Map": {
      const map = {};
      for (const { key, value } of node.entries) {
        const name = String(evaluate(key, scope, state));
        if (blocked(name)) throw new TemplateRenderError(`Refusing to write reserved key "${name}"`);
        map[name] = evaluate(value, scope, state);
      }
      return map;
    }
    case "Range": {
      const from = Math.trunc(toNumber(evaluate(node.from, scope, state)));
      const to = Math.trunc(toNumber(evaluate(node.to, scope, state)));
      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        throw new TemplateRenderError("Invalid range bounds");
      }
      const size = Math.abs(to - from) + 1;
      if (size > MAX_RANGE_SIZE) {
        throw new TemplateLimitError(`Range [${from}..${to}] exceeds ${MAX_RANGE_SIZE} elements`);
      }
      const out = [];
      if (from <= to) {
        for (let i = from; i <= to; i += 1) {
          tick(state);
          out.push(i);
        }
      } else {
        for (let i = from; i >= to; i -= 1) {
          tick(state);
          out.push(i);
        }
      }
      return out;
    }
    default:
      throw new TemplateRenderError(`Unknown expression node: ${node.type}`);
  }
}

/** Evaluates a Ref expression, tracking defined-ness for quiet rendering. */
function evaluateRef(node, scope, state) {
  try {
    return { found: true, value: evaluateRefInner(node, scope, state) };
  } catch (error) {
    if (error instanceof TemplateRenderError && (error.undefinedVariable || error.notFound)) {
      return { found: false, value: undefined };
    }
    throw error;
  }
}

/** Renders one missing reference inside "…" interpolation. */
function missingRefText(part) {
  return part.quiet ? "" : part.raw;
}

function evaluateRefInner(node, scope, state) {
  tick(state);
  switch (node.type) {
    case "Var": {
      const { found, value } = scope.lookup(node.name);
      if (!found) throw undefinedVar(node.name);
      return value ?? null;
    }
    case "Get": {
      const object = evaluateRefInner(node.object, scope, state);
      const key = evaluate(node.key, scope, state);
      const { found, value } = readProperty(object, key);
      if (!found) {
        const error = new TemplateRenderError("Unknown property");
        error.notFound = true;
        throw error;
      }
      return value ?? null;
    }
    case "Call": {
      const object = evaluateRefInner(node.object, scope, state);
      const args = node.args.map((arg) => evaluate(arg, scope, state));
      if (object !== null && typeof object === "object" && typeof object[node.method] === "function" && !blocked(node.method)) {
        return object[node.method](...args) ?? null;
      }
      return callMethod(object, node.method, args);
    }
    case "Interpolated":
    case "Literal":
    case "Binary":
    case "Unary":
    case "List":
    case "Map":
    case "Range":
      return evaluate(node, scope, state);
    default:
      throw new TemplateRenderError(`Unknown expression node: ${node.type}`);
  }
}

function assignTarget(target, value, scope, state) {
  tick(state);
  if (blocked(target.name)) throw new TemplateRenderError(`Refusing to write reserved key "${target.name}"`);
  if (target.segments.length === 0) {
    // `#set($x = …)` defines in the current scope (Velocity: local scope).
    scope.define(target.name, value);
    return;
  }
  const { found, value: base } = scope.lookup(target.name);
  let holder = found ? base : undefined;
  if (!isWritableHolder(holder)) {
    holder = {};
    if (!scope.assign(target.name, holder)) scope.define(target.name, holder);
  }
  let current = holder;
  for (let i = 0; i < target.segments.length; i += 1) {
    const segment = target.segments[i];
    const key = segment.kind === "prop" ? segment.name : String(evaluate(segment.key, scope, state));
    if (blocked(key)) throw new TemplateRenderError(`Refusing to write reserved key "${key}"`);
    if (i === target.segments.length - 1) {
      if (Array.isArray(current) && /^-?\d+$/.test(key)) current[Number(key)] = value;
      else if (isWritableHolder(current)) current[key] = value;
      else throw new TemplateRenderError(`Cannot assign into ${typeof current}`);
      return;
    }
    let next = current[key];
    if (!isWritableHolder(next)) {
      next = {};
      current[key] = next;
    }
    current = next;
  }
}

function isWritableHolder(value) {
  return typeof value === "object" && value !== null;
}
