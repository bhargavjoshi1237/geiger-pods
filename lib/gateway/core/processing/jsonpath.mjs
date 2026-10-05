/**
 * Minimal JSONPath evaluator for S06 mapping and template expressions.
 *
 * Supported (spec §5): `$`, `.name`, `['name']` / `["name"]`, `[n]`, `[-n]`,
 * `[a:b]` slices, `[*]` wildcards and `..name` recursive descent (templates
 * only — HTTP mapping validation rejects `..` and filters, as AWS does).
 * Filter expressions `[?(@.x == 'y')]` are templates-only (P2) with a small
 * comparison grammar (`== != < > <= >=`, `&& || !`, existence).
 *
 * Returns plain values only (no prototype-chain reads); `__proto__`,
 * `constructor` and `prototype` segments resolve to `undefined`.
 *
 * @module lib/gateway/core/processing/jsonpath
 */

const BLOCKED = new Set(["__proto__", "constructor", "prototype"]);

function isObject(value) {
  return typeof value === "object" && value !== null;
}

/** Safely reads one own-or-plain property, blocking prototype pollution. */
function safeGet(holder, key) {
  if (!isObject(holder)) return undefined;
  if (BLOCKED.has(key)) return undefined;
  if (Array.isArray(holder) && key === "length") return holder.length;
  return holder[key];
}

function descendants(node, out) {
  if (!isObject(node)) return;
  out.push(node);
  for (const value of Object.values(node)) {
    if (isObject(value)) descendants(value, out);
  }
}

/**
 * Parses a filter body such as `@.x == 'y' && @.n > 2` into a predicate.
 * Supports `@` with dotted/index segments on the left, a comparison
 * operator, and a string/number/boolean/null literal on the right, joined
 * by `&&` / `||` with optional `!` negation. Anything else is a compile
 * error (surfaced as a template parse error or mapping validation error).
 *
 * @param {string} body
 * @returns {(candidate: unknown) => boolean}
 */
export function compileFilter(body) {
  const orGroups = splitTopLevel(String(body), "||");
  const compiledOr = orGroups.map((group) =>
    splitTopLevel(group, "&&").map((term) => compileFilterTerm(term.trim())),
  );
  return (candidate) => compiledOr.some((andTerms) => andTerms.every((fn) => fn(candidate)));
}

function splitTopLevel(text, op) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[") depth += 1;
    if (ch === ")" || ch === "]") depth -= 1;
    if (depth === 0 && text.startsWith(op, i)) {
      parts.push(current);
      current = "";
      i += op.length - 1;
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function parseLiteral(raw) {
  const text = raw.trim();
  if (text === "null") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1);
  }
  const num = Number(text);
  if (text !== "" && Number.isFinite(num)) return num;
  throw new Error(`Unsupported filter literal: ${raw}`);
}

function readAtPath(candidate, expr) {
  let path = expr.trim();
  if (path === "@") return candidate;
  if (!path.startsWith("@")) throw new Error(`Filter path must start with @: ${expr}`);
  path = path.slice(1);
  let current = candidate;
  const segment = /(\.([A-Za-z0-9_]+)|\[['"]([^'"]+)['"]\]|\[(-?\d+)\])/g;
  let match = segment.exec(path);
  if (!match && path.length > 0) throw new Error(`Unsupported filter path: ${expr}`);
  while (match) {
    const [, , dot, quoted, index] = match;
    if (dot !== undefined) current = safeGet(current, dot);
    else if (quoted !== undefined) current = safeGet(current, quoted);
    else current = safeGet(current, Number(index));
    match = segment.exec(path);
  }
  return current;
}

function compareValues(left, operator, right) {
  switch (operator) {
    case "==": return left === right || String(left) === String(right);
    case "!=": return !(left === right || String(left) === String(right));
    case "<": return left < right;
    case ">": return left > right;
    case "<=": return left <= right;
    case ">=": return left >= right;
    default: throw new Error(`Unsupported filter operator: ${operator}`);
  }
}

function compileFilterTerm(term) {
  let negated = false;
  let rest = term;
  if (rest.startsWith("!")) {
    negated = true;
    rest = rest.slice(1).trim();
  }
  const match = rest.match(/^(@(?:[.\[].*)?)\s*(==|!=|<=|>=|<|>)\s*(.+)$/);
  let predicate;
  if (match) {
    const [, leftExpr, operator, rightRaw] = match;
    const right = parseLiteral(rightRaw);
    predicate = (candidate) => compareValues(readAtPath(candidate, leftExpr), operator, right);
  } else if (/^@(?:[.\[].*)?$/.test(rest)) {
    predicate = (candidate) => {
      const value = readAtPath(candidate, rest);
      return value !== undefined && value !== null && value !== false && value !== "";
    };
  } else {
    throw new Error(`Unsupported filter expression: ${term}`);
  }
  return negated ? (candidate) => !predicate(candidate) : predicate;
}

/**
 * Evaluates a JSONPath expression against a value.
 *
 * @param {unknown} root - Parsed JSON root.
 * @param {string} expression - JSONPath starting with `$`.
 * @param {{ allowRecursive?: boolean, allowFilter?: boolean }} [options]
 * @returns {unknown} Single value, an array when the path selects several
 *   nodes (`[*]`, slices, `..name`, filters), or `undefined` on no match.
 */
export function evaluateJsonPath(root, expression, options = {}) {
  const { allowRecursive = true, allowFilter = true } = options;
  const matches = selectJsonPath(root, expression, { allowRecursive, allowFilter });
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  return matches;
}

/**
 * Returns every node selected by a JSONPath expression.
 *
 * @param {unknown} root
 * @param {string} expression
 * @param {{ allowRecursive?: boolean, allowFilter?: boolean }} [options]
 * @returns {Array<unknown>}
 */
export function selectJsonPath(root, expression, options = {}) {
  const { allowRecursive = true, allowFilter = true } = options;
  if (typeof expression !== "string" || !expression.startsWith("$")) {
    throw new Error(`Invalid JSONPath (must start with $): ${expression}`);
  }
  let current = [root];
  let rest = expression.slice(1);
  while (rest.length > 0) {
    if (rest.startsWith("..")) {
      if (!allowRecursive) throw new Error(`Recursive descent (..) is not allowed here: ${expression}`);
      const nameMatch = rest.slice(2).match(/^([A-Za-z0-9_]+)(.*)$/s);
      if (!nameMatch) throw new Error(`Unsupported recursive expression: ${expression}`);
      const [, name, after] = nameMatch;
      const found = [];
      for (const node of current) {
        const pool = [];
        descendants(node, pool);
        for (const item of pool) {
          if (isObject(item) && !Array.isArray(item) && Object.hasOwn(item, name) && !BLOCKED.has(name)) {
            found.push(item[name]);
          }
        }
      }
      current = found;
      rest = after;
      continue;
    }
    if (rest.startsWith(".")) {
      const nameMatch = rest.slice(1).match(/^([A-Za-z0-9_]+|\*)(.*)$/s);
      if (!nameMatch) throw new Error(`Unsupported path segment: ${expression}`);
      const [, name, after] = nameMatch;
      if (name === "*") {
        current = current.flatMap((node) => (isObject(node) ? Object.values(node) : []));
      } else {
        current = current.map((node) => safeGet(node, name)).filter((v) => v !== undefined);
      }
      rest = after;
      continue;
    }
    if (rest.startsWith("[")) {
      const close = findBracketClose(rest);
      if (close < 0) throw new Error(`Unbalanced [ in JSONPath: ${expression}`);
      const inside = rest.slice(1, close);
      const after = rest.slice(close + 1);
      current = applyBracket(current, inside, expression, { allowFilter });
      rest = after;
      continue;
    }
    throw new Error(`Unsupported JSONPath syntax: ${expression}`);
  }
  return current;
}

function findBracketClose(text) {
  let quote = null;
  for (let i = 1; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "]") return i;
  }
  return -1;
}

function applyBracket(nodes, inside, expression, { allowFilter }) {
  const text = inside.trim();
  if (text === "*") {
    return nodes.flatMap((node) => {
      if (Array.isArray(node)) return [...node];
      if (isObject(node)) return Object.values(node);
      return [];
    });
  }
  const quoted = text.match(/^['"]([^'"]+)['"]$/);
  if (quoted) {
    return nodes.map((node) => safeGet(node, quoted[1])).filter((v) => v !== undefined);
  }
  const slice = text.match(/^(-?\d*)\s*:\s*(-?\d*)$/);
  if (slice) {
    return nodes.flatMap((node) => {
      if (!Array.isArray(node)) return [];
      const len = node.length;
      const start = slice[1] === "" ? 0 : Number(slice[1]) < 0 ? len + Number(slice[1]) : Number(slice[1]);
      const end = slice[2] === "" ? len : Number(slice[2]) < 0 ? len + Number(slice[2]) : Number(slice[2]);
      return node.slice(Math.max(0, start), Math.max(0, end));
    });
  }
  const index = text.match(/^(-?\d+)$/);
  if (index) {
    return nodes
      .map((node) => {
        if (!Array.isArray(node)) return undefined;
        const i = Number(index[1]) < 0 ? node.length + Number(index[1]) : Number(index[1]);
        return node[i];
      })
      .filter((v) => v !== undefined);
  }
  const union = text.match(/^(['"][^'"]+['"]\s*,.*)$/s);
  if (union && !text.startsWith("?(")) {
    const names = [...text.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
    return nodes.flatMap((node) => names.map((name) => safeGet(node, name)).filter((v) => v !== undefined));
  }
  const filter = text.match(/^\?\(\s*(.+)\s*\)$/s);
  if (filter) {
    if (!allowFilter) throw new Error(`Filter expressions are not allowed here: ${expression}`);
    const predicate = compileFilter(filter[1]);
    return nodes.flatMap((node) => {
      const list = Array.isArray(node) ? node : [node];
      return list.filter((item) => {
        try {
          return predicate(item);
        } catch {
          return false;
        }
      });
    });
  }
  throw new Error(`Unsupported bracket expression [${inside}] in ${expression}`);
}
