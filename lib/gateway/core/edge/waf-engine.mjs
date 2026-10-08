/**
 * WAF runtime engine (S11 §D4, phase 4 `edge/waf.mjs` logic).
 *
 * Rules evaluate in priority order. `ALLOW`/`BLOCK` terminate; `COUNT` adds
 * labels and continues. Nothing terminating → the default action applies. A
 * block → 403 `WAF_FILTERED` (or the rule's custom response). Sets
 * `$context.waf.{status,latency,error}`, `$context.wafResponseCode`
 * (`WAF_ALLOW`/`WAF_BLOCK`) and `$context.webaclArn`.
 *
 * Patterns are validated at save time (no backreferences/lookaround, no
 * nested quantified groups) and inputs are length-bounded, so evaluation
 * stays linear without a native RE2 dependency.
 *
 * @module lib/gateway/core/edge/waf-engine
 */

import { MANAGED_RULE_GROUPS } from "./waf-managed/index.mjs";
import { validateSafePattern } from "../redos.mjs";

/** First 8 KB of the body are inspected (AWS parity). */
export const BODY_INSPECT_LIMIT = 8 * 1024;

/** Sampled requests: last 3 h, up to 100 per rule per stage (S11 §D4). */
export const SAMPLE_TTL_MS = 3 * 60 * 60 * 1000;
export const SAMPLE_CAP = 100;

/** Rate-based evaluation windows (seconds). */
export const RATE_WINDOWS = [60, 120, 300, 600];

/**
 * Builds a normalized request view for field extraction.
 *
 * @param {{ method?: string, path?: string, query?: string, headers?: object,
 *   cookies?: string|null, body?: string|Buffer|null, sourceIp?: string }} input
 * @returns {{ method: string, path: string, query: string, queryParams: Array<[string,string]>,
 *   headers: Record<string,Array<string>>, cookies: Record<string,string>, body: string,
 *   bodyByteLength: number, bodyTruncated: boolean, sourceIp: string }}
 */
export function makeRequest(input = {}) {
  const rawQuery = String(input.query ?? "");
  const queryParams = [];
  if (rawQuery) {
    const search = rawQuery.startsWith("?") ? rawQuery.slice(1) : rawQuery;
    for (const part of search.split("&")) {
      if (!part) continue;
      const index = part.indexOf("=");
      const name = index === -1 ? part : part.slice(0, index);
      const value = index === -1 ? "" : part.slice(index + 1);
      try {
        queryParams.push([decodeURIComponent(name.replace(/\+/g, " ")), decodeURIComponent(value.replace(/\+/g, " "))]);
      } catch {
        queryParams.push([name, value]);
      }
    }
  }
  const headers = {};
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    const lower = String(key).toLowerCase();
    const values = Array.isArray(value) ? value.map(String) : [String(value)];
    headers[lower] = [...(headers[lower] ?? []), ...values];
  }
  const cookies = {};
  const cookieHeader = input.cookies ?? headers.cookie?.join("; ") ?? "";
  for (const part of String(cookieHeader).split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  const bodyText = typeof input.body === "string"
    ? input.body
    : Buffer.isBuffer(input.body)
      ? input.body.toString("utf8")
      : "";
  return {
    method: String(input.method ?? "GET").toUpperCase(),
    path: String(input.path ?? "/").split("?")[0] || "/",
    query: rawQuery.startsWith("?") ? rawQuery : (rawQuery ? `?${rawQuery}` : ""),
    queryParams,
    headers,
    cookies,
    body: bodyText,
    bodyByteLength: Buffer.byteLength(bodyText, "utf8"),
    bodyTruncated: Buffer.byteLength(bodyText, "utf8") > BODY_INSPECT_LIMIT,
    sourceIp: String(input.sourceIp ?? ""),
  };
}

/**
 * Builds a request view from a Web `Request` (phase use).
 *
 * @param {Request} request
 * @param {{ sourceIp?: string, body?: string|null }} [extra={}]
 * @returns {ReturnType<typeof makeRequest>}
 */
export function requestFromWebRequest(request, { sourceIp = "", body = null } = {}) {
  const url = new URL(request.url);
  const headers = {};
  for (const [key, value] of request.headers.entries()) {
    const lower = key.toLowerCase();
    headers[lower] = [...(headers[lower] ?? []), value];
  }
  const forwarded = headers["x-forwarded-for"]?.[0] ?? "";
  return makeRequest({
    method: request.method,
    path: url.pathname,
    query: url.search,
    headers,
    body: body ?? "",
    sourceIp: sourceIp || forwarded.split(",")[0]?.trim() || "",
  });
}

// ---------------------------------------------------------------------------
// Text transformations (S11 §D2, applied in order, ≤ 10).
// ---------------------------------------------------------------------------

function urlDecodeOnce(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function htmlEntityDecode(value) {
  return String(value)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return _;
      }
    })
    .replace(/&#(\d+);/g, (_, digits) => {
      try {
        return String.fromCodePoint(parseInt(digits, 10));
      } catch {
        return _;
      }
    })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'");
}

/** @type {Record<string, (value: string) => string>} */
export const TEXT_TRANSFORMS = {
  NONE: (value) => value,
  LOWERCASE: (value) => value.toLowerCase(),
  URL_DECODE: urlDecodeOnce,
  URL_DECODE_UNI: (value) => urlDecodeOnce(String(value).replace(/%u([0-9a-fA-F]{4})/g, (_, hex) => {
    try {
      return String.fromCharCode(parseInt(hex, 16));
    } catch {
      return _;
    }
  })),
  HTML_ENTITY_DECODE: htmlEntityDecode,
  COMPRESS_WHITE_SPACE: (value) => String(value).replace(/\s+/g, " ").trim(),
  CMD_LINE: (value) => String(value).replace(/[\\"'^]/g, ""),
  BASE64_DECODE: (value) => {
    const compact = String(value).replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) return value;
    try {
      return Buffer.from(compact, "base64").toString("utf8");
    } catch {
      return value;
    }
  },
  REMOVE_NULLS: (value) => String(value).replace(/\0/g, ""),
  NORMALIZE_PATH: (value) => {
    const segments = [];
    for (const part of String(value).split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        segments.pop();
        continue;
      }
      segments.push(part);
    }
    return `/${segments.join("/")}`;
  },
};

/**
 * Applies text transformations in order.
 *
 * @param {string} value
 * @param {Array<string>} [transforms=["NONE"]]
 * @returns {string}
 */
export function applyTransforms(value, transforms = ["NONE"]) {
  let out = String(value ?? "");
  for (const name of transforms ?? ["NONE"]) {
    const fn = TEXT_TRANSFORMS[name];
    if (!fn) throw new Error(`Unknown text transformation "${name}".`);
    out = fn(out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Field extraction (S11 §D2).
// ---------------------------------------------------------------------------

function jsonScalars(node, scope, out) {
  if (node === null || node === undefined) return;
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    if (scope === "VALUE" || scope === "ALL") out.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    if (scope === "ALL") out.push(JSON.stringify(node));
    for (const entry of node) jsonScalars(entry, scope, out);
    return;
  }
  if (typeof node === "object") {
    if (scope === "ALL") out.push(JSON.stringify(node));
    for (const [key, value] of Object.entries(node)) {
      if (scope === "KEY" || scope === "ALL") out.push(key);
      jsonScalars(value, scope, out);
    }
  }
}

/**
 * Extracts inspectable strings for a `fieldToMatch`.
 *
 * @param {object} fieldToMatch
 * @param {ReturnType<typeof makeRequest>} req
 * @returns {{ values: Array<string>, oversize: boolean }}
 */
export function extractFieldWithMeta(fieldToMatch, req) {
  const field = fieldToMatch ?? {};
  if (field.UriPath !== undefined) return { values: [req.path], oversize: false };
  if (field.QueryString !== undefined) return { values: [req.query], oversize: false };
  if (field.Method !== undefined) return { values: [req.method], oversize: false };
  if (field.SingleQueryArgument !== undefined) {
    const name = field.SingleQueryArgument?.name ?? field.SingleQueryArgument?.Name ?? "";
    return { values: req.queryParams.filter(([key]) => key === name).map(([, value]) => value), oversize: false };
  }
  if (field.AllQueryArguments !== undefined) {
    return { values: req.queryParams.map(([, value]) => value), oversize: false };
  }
  if (field.SingleHeader !== undefined) {
    const name = String(field.SingleHeader?.name ?? field.SingleHeader?.Name ?? "").toLowerCase();
    return { values: [...(req.headers[name] ?? [])], oversize: false };
  }
  if (field.Headers !== undefined) {
    return { values: Object.values(req.headers).flat(), oversize: false };
  }
  if (field.Cookies !== undefined) {
    const scope = field.Cookies?.matchScope ?? field.Cookies?.MatchScope ?? "ALL";
    const names = Object.keys(req.cookies);
    if (scope === "KEY") return { values: names, oversize: false };
    if (scope === "VALUE") return { values: Object.values(req.cookies), oversize: false };
    return { values: names.flatMap((name) => [name, req.cookies[name]]), oversize: false };
  }
  if (field.Body !== undefined) {
    const text = req.bodyTruncated ? req.body.slice(0, BODY_INSPECT_LIMIT) : req.body;
    return { values: [text], oversize: req.bodyTruncated };
  }
  if (field.JsonBody !== undefined) {
    const scope = field.JsonBody?.matchScope ?? field.JsonBody?.MatchScope ?? "ALL";
    try {
      const parsed = JSON.parse(req.body);
      const out = [];
      jsonScalars(parsed, String(scope).toUpperCase(), out);
      return { values: out, oversize: false };
    } catch {
      return { values: [], oversize: false, invalidJson: true };
    }
  }
  return { values: [], oversize: false };
}

/**
 * Extracts inspectable strings for a `fieldToMatch` (values only).
 *
 * @param {object} fieldToMatch
 * @param {ReturnType<typeof makeRequest>} req
 * @returns {Array<string>}
 */
export function extractField(fieldToMatch, req) {
  return extractFieldWithMeta(fieldToMatch, req).values;
}

// ---------------------------------------------------------------------------
// SQLi / XSS detectors (corpus-tested, S11 §D4).
// ---------------------------------------------------------------------------

const SQLI_LOW = [
  /'\s*(or|and)\s+('|\d)/,
  /"\s*(or|and)\s+("|')/,
  /\bor\s+1\s*=\s*1\b/,
  /\band\s+1\s*=\s*1\b/,
  /\bunion\b[\s\S]{0,300}\bselect\b/,
  /--(\s|$)/,
  /\/\*/,
  /;\s*(select|drop|insert|update|delete|union|exec|declare|create|alter)\b/,
  /waitfor\s+delay/,
  /sleep\s*\(/,
  /benchmark\s*\(/,
  /pg_sleep\s*\(/,
  /information_schema/,
  /load_file\s*\(/,
  /\binto\s+(outfile|dumpfile)\b/,
  /extractvalue\s*\(/,
  /updatexml\s*\(/,
];

const SQLI_HIGH_EXTRA = [
  /'\s*(or|and)\s+'?\w+'?\s*=\s*'?\w+/,
  /\)\s*or\s*\(/,
  /'\s*(order|group)\s+by\s+\d+/,
  /'\s*having\s+1\s*=\s*1\b/,
  /'\s*like\s+'/,
  /\bcast\s*\([\s\S]*\bselect\b/,
  /\bexists\s*\(\s*select\b/,
  /\bin\s*\(\s*select\b/,
  /;\s*exec\b/,
  /declare\s+@/,
  /xp_cmdshell/,
  /@@version/,
  /'\s*(or|and)\s+sleep\s*\(/,
  /'\s*and\s*\(\s*select\b/,
];

const XSS_PATTERNS = [
  /<\s*script\b/,
  /<\/\s*script/,
  /javascript\s*:/,
  /vbscript\s*:/,
  /data\s*:\s*text\/html/,
  /on\w+\s*=/,
  /document\s*\.\s*(cookie|domain)/,
  /window\s*\.\s*location/,
  /\balert\s*\(/,
  /\bprompt\s*\(/,
  /\bconfirm\s*\(/,
  /\beval\s*\(/,
  /fromcharcode/,
  /expression\s*\(/,
  /<\s*(iframe|object|embed|applet|frame|frameset|isindex|base|link|meta)\b/,
];

/**
 * Detects SQL injection payloads (LOW + HIGH sensitivity).
 *
 * @param {string} value
 * @param {"LOW"|"HIGH"} [sensitivity="LOW"]
 * @returns {boolean}
 */
export function detectSqli(value, sensitivity = "LOW") {
  const text = String(value ?? "").toLowerCase();
  const patterns = sensitivity === "HIGH" ? [...SQLI_LOW, ...SQLI_HIGH_EXTRA] : SQLI_LOW;
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Detects cross-site scripting payloads.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function detectXss(value) {
  const text = String(value ?? "").toLowerCase();
  return XSS_PATTERNS.some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// Regex safety (save-time, S11 §D1).
// ---------------------------------------------------------------------------

/**
 * Validates one regex pattern (RE2-safe subset, no ReDoS surface).
 *
 * @param {string} pattern
 * @returns {string|null} Error message, or null when accepted.
 */
export function validateRegexPattern(pattern) {
  // S15: canonical ReDoS-safe validation lives in `core/redos.mjs`; the WAF
  // cap stays 1024 (existing rule sets rely on it).
  return validateSafePattern(pattern, { maxLength: 1024 });
}

// ---------------------------------------------------------------------------
// CIDR matching.
// ---------------------------------------------------------------------------

function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    out = out * 256 + Number(part);
  }
  return out >>> 0;
}

function ipv6ToBig(ip) {
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const groups = [...head, ...Array(missing).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  let out = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    out = (out << 16n) + BigInt(parseInt(group, 16));
  }
  return out;
}

/**
 * Tests an IP against a CIDR (v4 + v6).
 *
 * @param {string} cidr
 * @param {string} ip
 * @returns {boolean}
 */
export function cidrContains(cidr, ip) {
  const [base, prefixRaw] = String(cidr).split("/");
  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix)) return false;
  if (base.includes(":")) {
    if (prefix < 0 || prefix > 128) return false;
    const baseInt = ipv6ToBig(base);
    const ipInt = ipv6ToBig(ip);
    if (baseInt === null || ipInt === null) return false;
    const shift = 128n - BigInt(prefix);
    return (baseInt >> shift) === (ipInt >> shift);
  }
  if (prefix < 0 || prefix > 32) return false;
  const baseInt = ipv4ToInt(base);
  const ipInt = ipv4ToInt(ip);
  if (baseInt === null || ipInt === null) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return ((baseInt & mask) >>> 0) === ((ipInt & mask) >>> 0);
}

// ---------------------------------------------------------------------------
// Statement evaluation.
// ---------------------------------------------------------------------------

/**
 * @typedef {{ ipSets?: Map<string,object>, regexSets?: Map<string,object>,
 *   labels?: Set<string>, country?: string|null, forwardedIp?: string|null,
 *   trustedProxyHeader?: string|null, kv?: object|null, now?: number,
 *   aclId?: string, managedGroups?: Map<string,object> }} WafContext
 */

function transformedValues(statement, values) {
  const transforms = statement?.textTransformations ?? ["NONE"];
  return values.map((value) => applyTransforms(value, transforms));
}

function oversizeVerdict(handling, matched) {
  if (handling === "MATCH") return true;
  if (handling === "NO_MATCH") return false;
  return matched;
}

/**
 * Evaluates one statement against a request.
 *
 * @param {object} statement
 * @param {ReturnType<typeof makeRequest>} req
 * @param {WafContext} [wctx={}]
 * @returns {{ matched: boolean, labels?: Set<string> }}
 */
export function evaluateStatement(statement, req, wctx = {}) {
  const type = statement?.type;
  switch (type) {
    case "IPSetReferenceStatement": {
      const set = wctx.ipSets?.get(statement.ipSetId);
      if (!set) return { matched: false };
      let ip = req.sourceIp;
      const forwarded = statement.forwardedIPConfig ?? statement.forwardedIpConfig ?? null;
      if (forwarded?.headerName) {
        const header = String(forwarded.headerName).toLowerCase();
        const trusted = wctx.trustedProxyHeader && header === String(wctx.trustedProxyHeader).toLowerCase();
        const values = req.headers[header] ?? [];
        if (values.length > 0 && (trusted || wctx.trustedProxyHeader === undefined)) {
          ip = values[0].split(",")[0].trim();
        } else if (forwarded.fallbackBehavior === "MATCH") {
          return { matched: true };
        } else if (forwarded.fallbackBehavior === "NO_MATCH") {
          return { matched: false };
        }
      }
      return { matched: (set.addresses ?? []).some((cidr) => cidrContains(cidr, ip)) };
    }
    case "GeoMatchStatement": {
      const codes = statement.countryCodes ?? [];
      if (!wctx.country) return { matched: false };
      return { matched: codes.includes(wctx.country) };
    }
    case "ByteMatchStatement": {
      const { values, oversize } = extractFieldWithMeta(statement.fieldToMatch, req);
      const handling = statement.oversizeHandling ?? "CONTINUE";
      const search = String(statement.searchString ?? "");
      const test = (value) => {
        switch (statement.positionalConstraint) {
          case "EXACTLY": return value === search;
          case "STARTS_WITH": return value.startsWith(search);
          case "ENDS_WITH": return value.endsWith(search);
          case "CONTAINS": return value.includes(search);
          case "CONTAINS_WORD": {
            const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            return new RegExp(`\\b${escaped}\\b`).test(value);
          }
          default: return false;
        }
      };
      const matched = transformedValues(statement, values).some(test);
      return { matched: oversize ? oversizeVerdict(handling, matched) : matched };
    }
    case "RegexMatchStatement": {
      const { values, oversize } = extractFieldWithMeta(statement.fieldToMatch, req);
      const handling = statement.oversizeHandling ?? "CONTINUE";
      let pattern;
      try {
        pattern = new RegExp(String(statement.regexString ?? ""));
      } catch {
        return { matched: false };
      }
      const matched = transformedValues(statement, values).some((value) => {
        try {
          return pattern.test(value.slice(0, BODY_INSPECT_LIMIT));
        } catch {
          return false;
        }
      });
      return { matched: oversize ? oversizeVerdict(handling, matched) : matched };
    }
    case "RegexPatternSetReferenceStatement": {
      const set = wctx.regexSets?.get(statement.regexSetId);
      if (!set) return { matched: false };
      const { values, oversize } = extractFieldWithMeta(statement.fieldToMatch ?? { UriPath: {} }, req);
      const handling = statement.oversizeHandling ?? "CONTINUE";
      const patterns = (set.patterns ?? []).map((source) => {
        try {
          return new RegExp(source);
        } catch {
          return null;
        }
      }).filter(Boolean);
      const matched = transformedValues(statement, values).some((value) =>
        patterns.some((pattern) => {
          try {
            return pattern.test(value.slice(0, BODY_INSPECT_LIMIT));
          } catch {
            return false;
          }
        }));
      return { matched: oversize ? oversizeVerdict(handling, matched) : matched };
    }
    case "SizeConstraintStatement": {
      const { values } = extractFieldWithMeta(statement.fieldToMatch, req);
      const size = Number(statement.size ?? 0);
      const compare = (bytes) => {
        switch (statement.comparisonOperator) {
          case "EQ": return bytes === size;
          case "NE": return bytes !== size;
          case "LE": return bytes <= size;
          case "LT": return bytes < size;
          case "GE": return bytes >= size;
          case "GT": return bytes > size;
          default: return false;
        }
      };
      // Body measures the full length (not the 8 KB inspection slice).
      if (statement.fieldToMatch?.Body !== undefined) {
        return { matched: compare(req.bodyByteLength) };
      }
      return { matched: transformedValues(statement, values).some((value) => compare(Buffer.byteLength(value, "utf8"))) };
    }
    case "SqliMatchStatement": {
      const { values, oversize, invalidJson } = extractFieldWithMeta(statement.fieldToMatch, req);
      if (invalidJson) {
        const fallback = statement.invalidFallbackBehavior ?? "MATCH";
        if (fallback === "MATCH") return { matched: true };
        if (fallback === "NO_MATCH") return { matched: false };
      }
      const handling = statement.oversizeHandling ?? "CONTINUE";
      const level = statement.sensitivityLevel ?? "LOW";
      const matched = transformedValues(statement, values).some((value) => detectSqli(value, level));
      return { matched: oversize ? oversizeVerdict(handling, matched) : matched };
    }
    case "XssMatchStatement": {
      const { values, oversize, invalidJson } = extractFieldWithMeta(statement.fieldToMatch, req);
      if (invalidJson) {
        const fallback = statement.invalidFallbackBehavior ?? "MATCH";
        if (fallback === "MATCH") return { matched: true };
        if (fallback === "NO_MATCH") return { matched: false };
      }
      const handling = statement.oversizeHandling ?? "CONTINUE";
      const matched = transformedValues(statement, values).some(detectXss);
      return { matched: oversize ? oversizeVerdict(handling, matched) : matched };
    }
    case "RateBasedStatement": {
      return evaluateRateBased(statement, req, wctx);
    }
    case "AndStatement": {
      const labels = new Set();
      for (const inner of statement.statements ?? []) {
        const out = evaluateStatement(inner, req, wctx);
        if (!out.matched) return { matched: false };
        for (const label of out.labels ?? []) labels.add(label);
      }
      return { matched: true, labels };
    }
    case "OrStatement": {
      const labels = new Set();
      for (const inner of statement.statements ?? []) {
        const out = evaluateStatement(inner, req, wctx);
        if (out.matched) {
          for (const label of out.labels ?? []) labels.add(label);
          return { matched: true, labels };
        }
      }
      return { matched: false };
    }
    case "NotStatement": {
      if (!statement.statement) return { matched: false };
      return { matched: !evaluateStatement(statement.statement, req, wctx).matched };
    }
    case "LabelMatchStatement": {
      return { matched: (wctx.labels ?? new Set()).has(String(statement.label ?? "")) };
    }
    case "ManagedRuleGroupStatement": {
      return evaluateManagedGroup(statement, req, wctx);
    }
    default:
      return { matched: false };
  }
}

function aggregateValue(statement, req, wctx) {
  switch (statement.aggregateKeyType ?? "IP") {
    case "FORWARDED_IP":
      return wctx.forwardedIp || req.sourceIp;
    case "CONSTANT":
      return "constant";
    case "CUSTOM_KEYS": {
      const parts = (statement.customKeys ?? []).map((key) => extractField(key.fieldToMatch ?? key, req).join(","));
      return parts.join("|");
    }
    case "IP":
    default:
      return req.sourceIp;
  }
}

/**
 * Sliding-window rate counting in KV (synchronous KV read path is async).
 *
 * @param {object} statement
 * @param {ReturnType<typeof makeRequest>} req
 * @param {WafContext} wctx
 * @returns {Promise<{ matched: boolean }>|{ matched: boolean }}
 */
function evaluateRateBased(statement, req, wctx) {
  const scopeDown = statement.scopeDownStatement ?? null;
  if (scopeDown && !evaluateStatement(scopeDown, req, wctx).matched) {
    return { matched: false };
  }
  const kv = wctx.kv ?? null;
  const windowSec = RATE_WINDOWS.includes(statement.evaluationWindowSec) ? statement.evaluationWindowSec : 60;
  const limit = Number(statement.limit ?? 0);
  const key = `waf:rate:${wctx.aclId ?? "acl"}:${statement._ruleName ?? "rule"}:${aggregateValue(statement, req, wctx)}`;
  if (!kv || typeof kv.get !== "function") {
    // Without state, counting degrades to a single-request check.
    return { matched: false };
  }
  const now = wctx.now ?? Date.now();
  return (async () => {
    let hits = [];
    try {
      const raw = await kv.get(key);
      if (raw) hits = JSON.parse(String(raw));
    } catch {
      hits = [];
    }
    const cutoff = now - windowSec * 1000;
    hits = (Array.isArray(hits) ? hits : []).filter((time) => time > cutoff);
    hits.push(now);
    try {
      await kv.set(key, JSON.stringify(hits), { ttlMs: windowSec * 1000 });
    } catch {
      // Best-effort counting only.
    }
    return { matched: hits.length > limit };
  })();
}

/**
 * Expands a Pods managed rule group (S11 §D3).
 *
 * @param {object} statement
 * @param {ReturnType<typeof makeRequest>} req
 * @param {WafContext} wctx
 * @returns {{ matched: boolean, labels?: Set<string> }}
 */
export function evaluateManagedGroup(statement, req, wctx) {
  const groups = wctx.managedGroups ?? MANAGED_RULE_GROUPS;
  const group = groups.get
    ? groups.get(statement.name)
    : groups[statement.name];
  if (!group) return { matched: false };
  const excluded = new Set(statement.excludedRules ?? []);
  const overrides = new Map((statement.ruleActionOverrides ?? []).map((entry) => [entry.name, entry.action]));
  const groupCount = (statement.overrideAction ?? null) === "COUNT";
  const labels = new Set();
  let blocked = false;
  for (const member of group.rules ?? []) {
    if (excluded.has(member.name)) continue;
    const out = evaluateStatement(member.statement, req, wctx);
    if (!out.matched) continue;
    const action = overrides.get(member.name) ?? member.action ?? "BLOCK";
    const label = `pods:managed:${group.name}:${member.name}`;
    labels.add(label);
    for (const extra of out.labels ?? []) labels.add(extra);
    if (!groupCount && action === "BLOCK") blocked = true;
  }
  return { matched: blocked, labels };
}

// ---------------------------------------------------------------------------
// Save-time validation.
// ---------------------------------------------------------------------------

const KNOWN_TRANSFORMS = Object.keys(TEXT_TRANSFORMS);
const MANAGED_GROUP_NAMES = ["PodsCommonRuleSet", "PodsSQLiRuleSet", "PodsKnownBadInputsRuleSet", "PodsAdminProtectionRuleSet"];

/**
 * Validates one statement at save time.
 *
 * @param {object} statement
 * @param {{ allowGeo?: boolean, ipSets?: Map<string,object>, regexSets?: Map<string,object> }} [options={}]
 * @returns {Array<string>} Error messages (empty when valid).
 */
export function validateStatement(statement, { allowGeo = true, ipSets = null, regexSets = null } = {}) {
  const errors = [];
  const checkTransforms = (list) => {
    const transforms = list ?? ["NONE"];
    if (!Array.isArray(transforms)) {
      errors.push("textTransformations must be an array");
      return;
    }
    if (transforms.length > 10) errors.push("at most 10 textTransformations are allowed");
    for (const name of transforms) {
      if (!KNOWN_TRANSFORMS.includes(name)) errors.push(`unknown text transformation "${name}"`);
    }
  };
  const checkField = (field) => {
    if (!field || typeof field !== "object" || Object.keys(field).length === 0) {
      errors.push("fieldToMatch is required");
    }
  };
  switch (statement?.type) {
    case "IPSetReferenceStatement": {
      if (!statement.ipSetId) errors.push("IPSetReferenceStatement requires ipSetId");
      else if (ipSets && !ipSets.has(statement.ipSetId)) errors.push(`IP set "${statement.ipSetId}" does not exist`);
      break;
    }
    case "GeoMatchStatement": {
      if (!Array.isArray(statement.countryCodes) || statement.countryCodes.length === 0) {
        errors.push("GeoMatchStatement requires countryCodes");
      }
      if (!allowGeo) {
        errors.push("GeoMatchStatement cannot be saved: no country source is configured (trusted header or PODS_GEOIP_DB)");
      }
      break;
    }
    case "ByteMatchStatement": {
      checkField(statement.fieldToMatch);
      if (!["EXACTLY", "STARTS_WITH", "ENDS_WITH", "CONTAINS", "CONTAINS_WORD"].includes(statement.positionalConstraint)) {
        errors.push("ByteMatchStatement requires a valid positionalConstraint");
      }
      if (typeof statement.searchString !== "string") errors.push("ByteMatchStatement requires searchString");
      checkTransforms(statement.textTransformations);
      break;
    }
    case "RegexMatchStatement": {
      checkField(statement.fieldToMatch);
      const error = validateRegexPattern(statement.regexString);
      if (error) errors.push(`RegexMatchStatement: ${error}`);
      checkTransforms(statement.textTransformations);
      break;
    }
    case "RegexPatternSetReferenceStatement": {
      if (!statement.regexSetId) errors.push("RegexPatternSetReferenceStatement requires regexSetId");
      else if (regexSets && !regexSets.has(statement.regexSetId)) errors.push(`regex set "${statement.regexSetId}" does not exist`);
      checkField(statement.fieldToMatch);
      checkTransforms(statement.textTransformations);
      break;
    }
    case "SizeConstraintStatement": {
      checkField(statement.fieldToMatch);
      if (!["EQ", "NE", "LE", "LT", "GE", "GT"].includes(statement.comparisonOperator)) {
        errors.push("SizeConstraintStatement requires a valid comparisonOperator");
      }
      if (!Number.isInteger(statement.size) || statement.size < 0) errors.push("SizeConstraintStatement requires a non-negative integer size");
      break;
    }
    case "SqliMatchStatement": {
      checkField(statement.fieldToMatch);
      if (statement.sensitivityLevel && !["LOW", "HIGH"].includes(statement.sensitivityLevel)) {
        errors.push("SqliMatchStatement sensitivityLevel must be LOW or HIGH");
      }
      checkTransforms(statement.textTransformations);
      break;
    }
    case "XssMatchStatement": {
      checkField(statement.fieldToMatch);
      checkTransforms(statement.textTransformations);
      break;
    }
    case "RateBasedStatement": {
      if (!Number.isInteger(statement.limit) || statement.limit < 10) {
        errors.push("RateBasedStatement limit must be an integer ≥ 10");
      }
      if (!RATE_WINDOWS.includes(statement.evaluationWindowSec)) {
        errors.push(`RateBasedStatement evaluationWindowSec must be one of ${RATE_WINDOWS.join(", ")}`);
      }
      if (!["IP", "FORWARDED_IP", "CONSTANT", "CUSTOM_KEYS"].includes(statement.aggregateKeyType ?? "IP")) {
        errors.push("RateBasedStatement requires a valid aggregateKeyType");
      }
      if (statement.scopeDownStatement) {
        for (const inner of validateStatement(statement.scopeDownStatement, { allowGeo, ipSets, regexSets })) {
          errors.push(`scopeDownStatement: ${inner}`);
        }
      }
      break;
    }
    case "AndStatement":
    case "OrStatement": {
      if (!Array.isArray(statement.statements) || statement.statements.length === 0) {
        errors.push(`${statement.type} requires at least one nested statement`);
      } else {
        for (const inner of statement.statements) {
          for (const innerError of validateStatement(inner, { allowGeo, ipSets, regexSets })) {
            errors.push(`${statement.type}: ${innerError}`);
          }
        }
      }
      break;
    }
    case "NotStatement": {
      if (!statement.statement) errors.push("NotStatement requires a nested statement");
      else {
        for (const innerError of validateStatement(statement.statement, { allowGeo, ipSets, regexSets })) {
          errors.push(`NotStatement: ${innerError}`);
        }
      }
      break;
    }
    case "LabelMatchStatement": {
      if (!statement.label || typeof statement.label !== "string") errors.push("LabelMatchStatement requires a label");
      break;
    }
    case "ManagedRuleGroupStatement": {
      if (!MANAGED_GROUP_NAMES.includes(statement.name)) errors.push(`unknown managed rule group "${statement.name}"`);
      break;
    }
    default:
      errors.push(`unknown statement type "${statement?.type}"`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Web ACL evaluation + sampled requests.
// ---------------------------------------------------------------------------

/**
 * Evaluates a web ACL in priority order (S11 §D4).
 *
 * @param {{ acl: { name: string, defaultAction: string, rules?: Array<object>, customResponses?: object },
 *   req: ReturnType<typeof makeRequest>, wctx?: WafContext }} options
 * @returns {Promise<{ action: "ALLOW"|"BLOCK"|"DEFAULT_ALLOW"|"DEFAULT_BLOCK",
 *   wafResponseCode: "WAF_ALLOW"|"WAF_BLOCK", labels: Set<string>,
 *   terminatedBy: string|null, customResponse: object|null }>}
 */
export async function evaluateWebAcl({ acl, req, wctx = {} }) {
  const labels = new Set(wctx.labels ?? []);
  const context = { ...wctx, labels, aclId: acl?.name ?? wctx.aclId };
  const ordered = [...(acl?.rules ?? [])].sort((a, b) => (a?.priority ?? 0) - (b?.priority ?? 0));
  for (const rule of ordered) {
    const statement = { ...rule.statement };
    const out = await evaluateRateBasedTag(statement, rule, req, context);
    if (!out.matched) continue;
    const action = rule.overrideAction === "COUNT" ? "COUNT" : (rule.action ?? "BLOCK");
    for (const label of out.labels ?? []) labels.add(label);
    if (rule.ruleLabels) for (const label of rule.ruleLabels) labels.add(label);
    labels.add(`pods:rule:${rule.name}`);
    if (action === "COUNT") continue;
    if (action === "ALLOW") {
      return { action: "ALLOW", wafResponseCode: "WAF_ALLOW", labels, terminatedBy: rule.name, customResponse: null };
    }
    const customResponses = acl?.customResponses ?? {};
    const customResponse = rule.customResponseKey && customResponses[rule.customResponseKey]
      ? { key: rule.customResponseKey, ...customResponses[rule.customResponseKey] }
      : null;
    return { action: "BLOCK", wafResponseCode: "WAF_BLOCK", labels, terminatedBy: rule.name, customResponse };
  }
  if ((acl?.defaultAction ?? "ALLOW") === "BLOCK") {
    return { action: "DEFAULT_BLOCK", wafResponseCode: "WAF_BLOCK", labels, terminatedBy: null, customResponse: null };
  }
  return { action: "DEFAULT_ALLOW", wafResponseCode: "WAF_ALLOW", labels, terminatedBy: null, customResponse: null };
}

async function evaluateRateBasedTag(statement, rule, req, wctx) {
  if (statement?.type === "RateBasedStatement") {
    return evaluateStatement({ ...statement, _ruleName: rule.name }, req, wctx);
  }
  return evaluateStatement(statement, req, wctx);
}

/**
 * Records a sampled request (last 3 h, ≤ 100 per rule per stage).
 *
 * @param {object} kv
 * @param {{ aclId: string, stage: string, ruleName: string, req: ReturnType<typeof makeRequest>,
 *   action: string, now?: number }} sample
 */
export async function recordSampledRequest(kv, { aclId, stage, ruleName, req, action, now = Date.now() }) {
  const key = `waf:samples:${aclId}:${stage}:${ruleName}`;
  let samples = [];
  try {
    const raw = await kv.get(key);
    if (raw) samples = JSON.parse(String(raw));
  } catch {
    samples = [];
  }
  samples = (Array.isArray(samples) ? samples : []).filter((entry) => now - entry.t < SAMPLE_TTL_MS);
  samples.push({
    t: now,
    method: req.method,
    path: req.path,
    query: req.query,
    sourceIp: req.sourceIp,
    country: null,
    action,
  });
  while (samples.length > SAMPLE_CAP) samples.shift();
  try {
    await kv.set(key, JSON.stringify(samples), { ttlMs: SAMPLE_TTL_MS });
  } catch {
    // Sampling never blocks.
  }
}

/**
 * Reads sampled requests for a rule/stage.
 *
 * @param {object} kv
 * @param {{ aclId: string, stage: string, ruleName: string, now?: number }} options
 * @returns {Promise<Array<object>>}
 */
export async function getSampledRequests(kv, { aclId, stage, ruleName, now = Date.now() }) {
  try {
    const raw = await kv.get(`waf:samples:${aclId}:${stage}:${ruleName}`);
    const samples = raw ? JSON.parse(String(raw)) : [];
    return (Array.isArray(samples) ? samples : []).filter((entry) => now - entry.t < SAMPLE_TTL_MS);
  } catch {
    return [];
  }
}
