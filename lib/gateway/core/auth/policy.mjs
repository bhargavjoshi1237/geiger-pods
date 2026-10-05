/**
 * IAM-style policy grammar evaluator (S07 §6).
 *
 * Identity policies (`pods.signing_policies.document`) and resource policies
 * (S07 §7, `auth/resource-policy.mjs`) share this one evaluator:
 * ```
 * { Version: "2012-10-17",
 *   Statement: [{ Sid?, Effect: "Allow"|"Deny", Principal? (resource policies only),
 *     Action | NotAction, Resource | NotResource, Condition? }] }
 * ```
 * `Action` values: `"execute-api:Invoke"`, `"execute-api:*"` or `"*"` (or a
 * list). `Resource`/`NotResource` entries are method ARNs or IAM globs where
 * `*` matches any run of characters (segment-agnostic) and `?` matches one
 * character. The `arn:aws:execute-api:` prefix is accepted as an alias of
 * `arn:pods:execute-api:`.
 *
 * Condition operators: `StringEquals`, `StringNotEquals`, `StringLike`,
 * `StringNotLike`, `IpAddress`, `NotIpAddress`, `DateGreaterThan`,
 * `DateLessThan`, `Bool`, `Null`, each with optional `ForAnyValue:` /
 * `ForAllValues:` prefixes for multi-valued keys. Keys: `aws:SourceIp`,
 * `aws:SourceVpce`, `aws:SourceVpc`, `aws:UserAgent`, `aws:Referer`,
 * `aws:CurrentTime`, `aws:EpochTime`, `aws:SecureTransport`,
 * `aws:PrincipalArn`, `aws:PrincipalTag/<k>`; the `pods:` prefix is accepted
 * as a synonym. Unknown keys or operators are invalid at save time
 * ({@link validatePolicyDocument}) and fail closed at runtime.
 *
 * Evaluation: explicit Deny > Allow > implicit deny (IAM).
 *
 * Pure ES module: no I/O, no clock reads (the caller passes `nowMs`).
 *
 * @module lib/gateway/core/auth/policy
 */

/** Pods method-ARN prefix; the AWS prefix is an accepted alias. */
export const PODS_ARN_PREFIX = "arn:pods:execute-api:";
export const AWS_ARN_PREFIX = "arn:aws:execute-api:";

/**
 * Builds a Pods method ARN so existing authorizer code that splits on `:`
 * and `/` keeps working:
 * `arn:pods:execute-api:{region}:{projectId}:{apiPublicId}/{stage}/{METHOD}/{resourcePath}`
 *
 * @param {{ region?: string, projectId?: string, apiPublicId?: string, stage?: string, method?: string, resourcePath?: string }} parts
 * @returns {string}
 */
export function buildMethodArn({
  region = "auto",
  projectId = "",
  apiPublicId = "",
  stage = "",
  method = "",
  resourcePath = "",
} = {}) {
  const path = String(resourcePath ?? "").replace(/^\/+/, "");
  return `${PODS_ARN_PREFIX}${region ?? "auto"}:${projectId ?? ""}:${apiPublicId ?? ""}/${stage ?? ""}/${String(method ?? "").toUpperCase()}/${path}`;
}

/**
 * Returns the principal ARN of a signing credential.
 *
 * @param {{ projectId?: string, accessKeyId?: string }} parts
 * @returns {string}
 */
export function credentialPrincipalArn({ projectId = "", accessKeyId = "" } = {}) {
  return `arn:pods:iam::${projectId ?? ""}:credential/${accessKeyId ?? ""}`;
}

function normalizeArn(arn) {
  const text = String(arn ?? "");
  if (text.startsWith(AWS_ARN_PREFIX)) return PODS_ARN_PREFIX + text.slice(AWS_ARN_PREFIX.length);
  return text;
}

/**
 * IAM glob match: `*` matches any run of characters (including `/`), `?`
 * matches exactly one character. Everything else is literal.
 *
 * @param {string} pattern
 * @param {string} value
 * @returns {boolean}
 */
export function matchGlob(pattern, value) {
  const text = String(pattern ?? "");
  const target = String(value ?? "");
  let regex = "^";
  for (const char of text) {
    if (char === "*") regex += ".*";
    else if (char === "?") regex += ".";
    else regex += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  regex += "$";
  return new RegExp(regex, "s").test(target);
}

/**
 * Matches a policy resource entry against a concrete ARN (alias-aware glob).
 *
 * @param {string} pattern - Policy resource entry (ARN or glob).
 * @param {string} arn - Concrete method/route ARN.
 * @returns {boolean}
 */
export function matchArn(pattern, arn) {
  return matchGlob(normalizeArn(pattern), normalizeArn(arn));
}

// ---------------------------------------------------------------------------
// Condition context
// ---------------------------------------------------------------------------

/**
 * Request facts condition keys resolve against. All fields optional; missing
 * values make the key "null" for `Null` and fail other operators closed.
 * @typedef {object} PolicyRequestContext
 * @property {string} [sourceIp]
 * @property {string} [connectorId] - `aws:SourceVpce` (private APIs, S11).
 * @property {string} [sourceVpc] - `aws:SourceVpc`.
 * @property {string} [userAgent] - `aws:UserAgent`.
 * @property {string} [referer] - `aws:Referer`.
 * @property {number} [nowMs] - `aws:CurrentTime` / `aws:EpochTime` basis.
 * @property {boolean} [secureTransport] - `aws:SecureTransport`.
 * @property {string} [principalArn] - `aws:PrincipalArn`.
 * @property {Record<string,string>} [principalTags] - `aws:PrincipalTag/<k>`.
 */

const KNOWN_KEYS = new Set([
  "sourceip", "sourcevpce", "sourcevpc", "useragent", "referer",
  "currenttime", "epochtime", "securetransport", "principalarn",
]);

/**
 * Normalizes a condition key: strips the `aws:`/`pods:` prefix synonym and
 * lowercases. `aws:PrincipalTag/team` → `principaltag/team`.
 *
 * @param {string} key
 * @returns {string}
 */
export function normalizeKey(key) {
  return String(key ?? "").replace(/^(aws|pods):/i, "").toLowerCase();
}

/**
 * Resolves one condition key to its request values (always an array; empty
 * means the key is absent/null).
 *
 * @param {string} key - Raw condition key as written in the policy.
 * @param {PolicyRequestContext} [request={}]
 * @returns {Array<string>}
 */
export function resolveKey(key, request = {}) {
  const name = normalizeKey(key);
  const req = request ?? {};
  if (name === "sourceip") return req.sourceIp != null && req.sourceIp !== "" ? [String(req.sourceIp)] : [];
  if (name === "sourcevpce") return req.connectorId != null && req.connectorId !== "" ? [String(req.connectorId)] : [];
  if (name === "sourcevpc") return req.sourceVpc != null && req.sourceVpc !== "" ? [String(req.sourceVpc)] : [];
  if (name === "useragent") return req.userAgent != null && req.userAgent !== "" ? [String(req.userAgent)] : [];
  if (name === "referer") return req.referer != null && req.referer !== "" ? [String(req.referer)] : [];
  if (name === "currenttime") {
    if (req.nowMs == null) return [];
    return [new Date(Number(req.nowMs)).toISOString()];
  }
  if (name === "epochtime") {
    if (req.nowMs == null) return [];
    return [String(Math.floor(Number(req.nowMs) / 1000))];
  }
  if (name === "securetransport") {
    if (req.secureTransport == null) return [];
    return [req.secureTransport ? "true" : "false"];
  }
  if (name === "principalarn") return req.principalArn != null && req.principalArn !== "" ? [String(req.principalArn)] : [];
  if (name.startsWith("principaltag/")) {
    const tag = key.slice(key.indexOf("/") + 1);
    const tags = req.principalTags ?? {};
    const found = Object.hasOwn(tags, tag) ? tags[tag]
      : Object.entries(tags).find(([name]) => name.toLowerCase() === tag.toLowerCase())?.[1];
    return found != null && found !== "" ? [String(found)] : [];
  }
  return [];
}

/**
 * Returns true when the key name (ignoring prefix) is a known condition key.
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isKnownKey(key) {
  const name = normalizeKey(key);
  return KNOWN_KEYS.has(name) || name.startsWith("principaltag/");
}

// ---------------------------------------------------------------------------
// Condition operators
// ---------------------------------------------------------------------------

const OPERATORS = new Set([
  "StringEquals", "StringNotEquals", "StringLike", "StringNotLike",
  "IpAddress", "NotIpAddress", "DateGreaterThan", "DateLessThan",
  "Bool", "Null",
]);

/**
 * Splits `ForAnyValue:StringLike` into `{ setOp: "ForAnyValue", op: "StringLike" }`.
 *
 * @param {string} name
 * @returns {{ setOp: string|null, op: string }}
 */
export function parseOperator(name) {
  const text = String(name ?? "");
  const match = text.match(/^(ForAnyValue|ForAllValues):(.+)$/);
  if (match) return { setOp: match[1], op: match[2] };
  return { setOp: null, op: text };
}

function toArray(value) {
  return Array.isArray(value) ? value : [value];
}

function parseIPv4(text) {
  const parts = String(text).split(".");
  if (parts.length !== 4) return null;
  const bytes = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const num = Number(part);
    if (num > 255) return null;
    bytes.push(num);
  }
  return bytes;
}

function parseIPv6(text) {
  let addr = String(text).toLowerCase();
  let tail = [];
  const v4match = addr.match(/:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4match) {
    const v4 = parseIPv4(v4match[1]);
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    addr = addr.slice(0, addr.length - v4match[0].length);
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half) => {
    if (half === "") return [];
    return half.split(":").map((group) => {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return NaN;
      return Number.parseInt(group, 16);
    });
  };
  const head = parseHalf(halves[0]);
  if (head.some((group) => Number.isNaN(group))) return null;
  if (halves.length === 1) {
    const groups = [...head, ...tail];
    return groups.length === 8 ? groups : null;
  }
  const end = parseHalf(halves[1]);
  if (end.some((group) => Number.isNaN(group))) return null;
  const missing = 8 - tail.length - head.length - end.length;
  if (missing < 1) return null;
  return [...head, ...new Array(missing).fill(0), ...end, ...tail];
}

function v4ToInt(bytes) {
  return (((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0);
}

function v6ToBigInt(groups) {
  let value = 0n;
  for (const group of groups) value = (value << 16n) | BigInt(group);
  return value;
}

function parseCidr(cidr) {
  const text = String(cidr ?? "").trim().replace(/^\[|\]$/g, "");
  const slash = text.lastIndexOf("/");
  const address = slash >= 0 ? text.slice(0, slash) : text;
  const v4 = parseIPv4(address);
  if (v4) {
    const bits = slash >= 0 ? Number(text.slice(slash + 1)) : 32;
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
    return { family: 4, addr: v4ToInt(v4), bits };
  }
  const v6 = parseIPv6(address);
  if (v6) {
    const bits = slash >= 0 ? Number(text.slice(slash + 1)) : 128;
    if (!Number.isInteger(bits) || bits < 0 || bits > 128) return null;
    return { family: 6, addr: v6ToBigInt(v6), bits };
  }
  return null;
}

function parseIpLiteral(text) {
  const clean = String(text ?? "").trim().replace(/^\[|\]$/g, "");
  const v4 = parseIPv4(clean);
  if (v4) return { family: 4, addr: v4ToInt(v4) };
  const v6 = parseIPv6(clean);
  if (v6) return { family: 6, addr: v6ToBigInt(v6) };
  return null;
}

/**
 * Tests an IP against a CIDR (or bare IP). v4 and v6 never match each other.
 *
 * @param {string} ip
 * @param {string} cidr
 * @returns {boolean}
 */
export function matchCidr(ip, cidr) {
  const range = parseCidr(cidr);
  const addr = parseIpLiteral(ip);
  if (!range || !addr || range.family !== addr.family) return false;
  if (range.family === 4) {
    const mask = range.bits === 0 ? 0 : (0xffffffff << (32 - range.bits)) >>> 0;
    return ((addr.addr & mask) >>> 0) === ((range.addr & mask) >>> 0);
  }
  if (range.bits === 0) return true;
  const shift = 128n - BigInt(range.bits);
  return (addr.addr >> shift) === (range.addr >> shift);
}

function toDateMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Evaluates one operator against one key's values. Unknown operators fail
 * closed (false); callers surface them at save time.
 *
 * @param {string} op - Bare operator name (no `ForAnyValue:` prefix).
 * @param {Array<string>} actual - Request values for the key (empty = absent).
 * @param {unknown} expected - Policy values for the key.
 * @returns {boolean}
 */
export function evalSingleCondition(op, actual, expected) {
  const want = toArray(expected);
  switch (op) {
    case "StringEquals":
      return actual.some((value) => want.some((item) => String(value) === String(item)));
    case "StringNotEquals":
      if (actual.length === 0) return false;
      return actual.every((value) => want.every((item) => String(value) !== String(item)));
    case "StringLike":
      return actual.some((value) => want.some((item) => matchGlob(String(item), String(value))));
    case "StringNotLike":
      if (actual.length === 0) return false;
      return actual.every((value) => want.every((item) => !matchGlob(String(item), String(value))));
    case "IpAddress":
      return actual.some((value) => want.some((item) => matchCidr(String(value), String(item))));
    case "NotIpAddress":
      if (actual.length === 0) return false;
      return actual.every((value) => want.every((item) => !matchCidr(String(value), String(item))));
    case "DateGreaterThan": {
      return actual.some((value) => {
        const actualMs = toDateMs(value);
        return actualMs !== null && want.some((item) => {
          const wantMs = toDateMs(item);
          return wantMs !== null && actualMs > wantMs;
        });
      });
    }
    case "DateLessThan": {
      return actual.some((value) => {
        const actualMs = toDateMs(value);
        return actualMs !== null && want.some((item) => {
          const wantMs = toDateMs(item);
          return wantMs !== null && actualMs < wantMs;
        });
      });
    }
    case "Bool":
      return actual.some((value) => {
        const normalized = String(value).toLowerCase();
        return want.some((item) => {
          const wantBool = typeof item === "boolean" ? item : String(item).toLowerCase() === "true" ? true : String(item).toLowerCase() === "false" ? false : null;
          if (wantBool === null) return false;
          return (normalized === "true") === wantBool;
        });
      });
    case "Null":
      return want.some((item) => {
        const wantNull = typeof item === "boolean" ? item : String(item).toLowerCase() === "true";
        return wantNull ? actual.length === 0 : actual.length > 0;
      });
    default:
      return false;
  }
}

/**
 * Evaluates a full condition block. `ForAnyValue:` is true when the inner
 * operator holds for at least one request value; `ForAllValues:` is true
 * when it holds for every request value (vacuously true on empty sets, per
 * IAM). All top-level operators AND together; keys within one operator AND.
 *
 * @param {Record<string, Record<string, unknown>>} [condition={}]
 * @param {PolicyRequestContext} [request={}]
 * @returns {boolean}
 */
export function evalCondition(condition = {}, request = {}) {
  return evalBlock(condition, (key) => resolveKey(key, request));
}

/**
 * Evaluates a condition block against a flat key bag (the policy-simulator
 * shape: `{ "aws:SourceIp": "1.2.3.4" }` or `{ "aws:useragent": [...] }`).
 * Key lookup is case-insensitive; single values behave as one-element sets.
 *
 * @param {Record<string, Record<string, unknown>>} [condition={}]
 * @param {Record<string, unknown>} [bag={}]
 * @returns {boolean}
 */
export function testCondition(condition = {}, bag = {}) {
  const entries = Object.entries(bag ?? {});
  return evalBlock(condition, (key) => {
    const lower = String(key).toLowerCase();
    for (const [name, value] of entries) {
      if (String(name).toLowerCase() === lower) {
        if (value === null || value === undefined) return [];
        return (Array.isArray(value) ? value : [value]).map((entry) => String(entry));
      }
    }
    return [];
  });
}

/**
 * Shared condition-block evaluator over an injected key resolver.
 *
 * @param {Record<string, Record<string, unknown>>} [condition={}]
 * @param {(key: string) => Array<string>} resolve - Request values for one key.
 * @returns {boolean}
 */
function evalBlock(condition = {}, resolve) {
  const block = condition ?? {};
  for (const [rawOp, keyMap] of Object.entries(block)) {
    const { setOp, op } = parseOperator(rawOp);
    if (!OPERATORS.has(op)) return false;
    if (!keyMap || typeof keyMap !== "object") return false;
    for (const [key, expected] of Object.entries(keyMap)) {
      if (!isKnownKey(key)) return false;
      const actual = resolve(key);
      if (setOp === null) {
        if (!evalSingleCondition(op, actual, expected)) return false;
      } else if (setOp === "ForAnyValue") {
        const values = actual.length > 0 ? actual : [null];
        const any = values.some((value) =>
          evalSingleCondition(op, value === null ? [] : [value], expected));
        if (!any) return false;
      } else {
        const values = actual.length > 0 ? actual : [null];
        const all = values.every((value) =>
          evalSingleCondition(op, value === null ? [] : [value], expected));
        if (!all) return false;
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Statements and documents
// ---------------------------------------------------------------------------

function actionMatches(entry, action) {
  const wanted = String(entry ?? "");
  if (wanted === "*" || wanted === "execute-api:*") return true;
  return wanted.toLowerCase() === String(action ?? "").toLowerCase();
}

function statementActionApplies(statement, action) {
  const target = action ?? "execute-api:Invoke";
  if (statement.Action !== undefined) {
    return toArray(statement.Action).some((entry) => actionMatches(entry, target));
  }
  if (statement.NotAction !== undefined) {
    return !toArray(statement.NotAction).some((entry) => actionMatches(entry, target));
  }
  return false;
}

function statementResourceApplies(statement, resource) {
  const target = normalizeArn(resource);
  if (statement.Resource !== undefined) {
    return toArray(statement.Resource).some((entry) => matchArn(entry, target));
  }
  if (statement.NotResource !== undefined) {
    return !toArray(statement.NotResource).some((entry) => matchArn(entry, target));
  }
  return false;
}

/**
 * Validates a policy document at save time. Returns `{ ok, errors }` where
 * `errors` is a list of `{ path, message }` problems (empty = valid).
 * Unknown operators and unknown condition keys are rejected here so the
 * runtime can fail closed on the (unreachable) remainder.
 *
 * @param {unknown} document
 * @param {{ allowPrincipal?: boolean }} [options={}]
 * @returns {{ ok: boolean, errors: Array<{ path: string, message: string }> }}
 */
export function validatePolicyDocument(document, { allowPrincipal = false } = {}) {
  const problems = [];
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return { ok: false, errors: [{ path: "$", message: "Policy document must be an object." }] };
  }
  const statements = document.Statement;
  if (!Array.isArray(statements) || statements.length === 0) {
    return { ok: false, errors: [{ path: "$.Statement", message: "Policy document must have a non-empty Statement array." }] };
  }
  statements.forEach((statement, index) => {
    const prefix = `$.Statement[${index}]`;
    if (!statement || typeof statement !== "object") {
      problems.push({ path: prefix, message: "Statement must be an object." });
      return;
    }
    if (statement.Effect !== "Allow" && statement.Effect !== "Deny") {
      problems.push({ path: `${prefix}.Effect`, message: "Effect must be Allow or Deny." });
    }
    if (statement.Action === undefined && statement.NotAction === undefined) {
      problems.push({ path: prefix, message: "Statement must have Action or NotAction." });
    }
    if (statement.Action !== undefined && statement.NotAction !== undefined) {
      problems.push({ path: prefix, message: "Statement must not have both Action and NotAction." });
    }
    for (const key of ["Action", "NotAction"]) {
      if (statement[key] === undefined) continue;
      for (const entry of toArray(statement[key])) {
        const ok = typeof entry === "string"
          && (entry === "*" || entry === "execute-api:*" || entry.toLowerCase() === "execute-api:invoke");
        if (!ok) problems.push({ path: `${prefix}.${key}`, message: `Unsupported action "${entry}".` });
      }
    }
    if (statement.Resource === undefined && statement.NotResource === undefined) {
      problems.push({ path: prefix, message: "Statement must have Resource or NotResource." });
    }
    if (statement.Resource !== undefined && statement.NotResource !== undefined) {
      problems.push({ path: prefix, message: "Statement must not have both Resource and NotResource." });
    }
    if (statement.Principal !== undefined && !allowPrincipal) {
      problems.push({ path: `${prefix}.Principal`, message: "Principal is only allowed in resource policies." });
    }
    if (statement.Condition !== undefined) {
      if (!statement.Condition || typeof statement.Condition !== "object" || Array.isArray(statement.Condition)) {
        problems.push({ path: `${prefix}.Condition`, message: "Condition must be an object." });
      } else {
        for (const [rawOp, keyMap] of Object.entries(statement.Condition)) {
          const { op } = parseOperator(rawOp);
          if (!OPERATORS.has(op)) {
            problems.push({ path: `${prefix}.Condition.${rawOp}`, message: `Unknown condition operator "${rawOp}".` });
            continue;
          }
          if (!keyMap || typeof keyMap !== "object") {
            problems.push({ path: `${prefix}.Condition.${rawOp}`, message: "Condition operator value must be an object." });
            continue;
          }
          for (const key of Object.keys(keyMap)) {
            if (!isKnownKey(key)) {
              problems.push({ path: `${prefix}.Condition.${rawOp}.${key}`, message: `Unknown condition key "${key}".` });
            }
          }
        }
      }
    }
  });
  return { ok: problems.length === 0, errors: problems };
}

/**
 * Evaluates a policy document for one action on one resource.
 *
 * @param {{ document: object, action?: string, resource: string, request?: PolicyRequestContext, matchPrincipal?: (principal: unknown) => boolean }} input
 * @returns {{ decision: "Allow" | "Deny" | "ImplicitDeny", matched: Array<{ effect: string, index: number, sid?: string }> }}
 */
export function evaluatePolicy({ document, action = "execute-api:Invoke", resource, request = {}, matchPrincipal = null } = {}) {
  const statements = document?.Statement ?? [];
  let allowed = false;
  let denied = false;
  const matched = [];
  statements.forEach((statement, index) => {
    if (!statement || typeof statement !== "object") return;
    if (matchPrincipal && statement.Principal !== undefined && !matchPrincipal(statement.Principal)) return;
    if (!statementActionApplies(statement, action)) return;
    if (!statementResourceApplies(statement, resource)) return;
    if (statement.Condition !== undefined && !evalCondition(statement.Condition, request)) return;
    matched.push({ effect: statement.Effect, index, ...(statement.Sid !== undefined ? { sid: statement.Sid } : {}) });
    if (statement.Effect === "Deny") {
      denied = true;
      allowed = false;
    } else if (statement.Effect === "Allow" && !denied) {
      allowed = true;
    }
  });
  if (matched.some((entry) => entry.effect === "Deny")) return { decision: "Deny", matched };
  if (allowed) return { decision: "Allow", matched };
  return { decision: "ImplicitDeny", matched };
}
