/**
 * Tracing (S10 §5, REST): W3C trace context, sampling rules, OTLP export.
 *
 * - Accepts inbound `traceparent`/`tracestate` (W3C) or `X-Amzn-Trace-Id`
 *   (`Root=1-…;Parent=…;Sampled=1`, converted to W3C). Always forwards
 *   `traceparent` to integrations. `$context.traceId` carries the trace id.
 * - Sampling rules at project level; the default rule is 1 req/s reservoir
 *   + 5 % (X-Ray default).
 * - Spans: `gateway` (root/server) with children `waf`, `authorizer`,
 *   `cache`, `integration` (client span, `http.*` attributes), `function`.
 * - Export: OTLP/HTTP JSON in batches (injectable `fetch`); the built-in
 *   viewer stores sampled spans 7 days in `pods.trace_spans`.
 *
 * @module lib/gateway/core/observe/tracing
 */

import { randomUUID } from "node:crypto";

const TRACEPARENT_PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const X_AMZN_ROOT = /^1-([0-9a-f]{8})-([0-9a-f]{24})$/i;

/**
 * Parses a W3C `traceparent` value.
 *
 * @param {string|null|undefined} value
 * @returns {{ version: string, traceId: string, parentId: string, sampled: boolean }|null}
 */
export function parseTraceparent(value) {
  const match = TRACEPARENT_PATTERN.exec(String(value ?? "").trim());
  if (!match) return null;
  const [, version, traceId, parentId, flags] = match;
  if (traceId === "0".repeat(32) || parentId === "0".repeat(16)) return null;
  return { version, traceId: traceId.toLowerCase(), parentId: parentId.toLowerCase(), sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}

/**
 * Builds a W3C `traceparent` value.
 *
 * @param {{ traceId: string, parentId: string, sampled?: boolean }} parts
 * @returns {string}
 */
export function buildTraceparent({ traceId, parentId, sampled = true }) {
  return `00-${traceId}-${parentId}-0${sampled ? "1" : "0"}`;
}

/**
 * Converts an `X-Amzn-Trace-Id` header to W3C parts. AWS format:
 * `Root=1-<8 hex>-<24 hex>;Parent=<16 hex>;Sampled=0|1`.
 *
 * @param {string|null|undefined} value
 * @returns {{ traceId: string, parentId: string|null, sampled: boolean }|null}
 */
export function traceparentFromAmzn(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const fields = {};
  for (const part of text.split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0) fields[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
  }
  const root = X_AMZN_ROOT.exec(fields.Root ?? "");
  if (!root) return null;
  const [, time, unique] = root;
  const traceId = `${time}${unique}`.toLowerCase();
  const parentId = fields.Parent && /^[0-9a-f]{16}$/i.test(fields.Parent) ? fields.Parent.toLowerCase() : null;
  return { traceId, parentId, sampled: fields.Sampled === "1" };
}

/** Random 16-hex-char span id. */
export function newSpanId() {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

/** Random 32-hex-char trace id (W3C shape). */
export function newTraceId() {
  return randomUUID().replace(/-/g, "");
}

/**
 * Resolves the inbound trace context for a request: W3C first, then
 * `X-Amzn-Trace-Id`, else a fresh trace. Returns the context plus the
 * `traceparent` to forward upstream.
 *
 * @param {Headers|Record<string,string>} headers
 * @returns {{ traceId: string, parentId: string|null, sampled: boolean|null,
 *   incoming: string|null, forward: string }}
 */
export function resolveInboundTrace(headers) {
  const get = (name) => {
    if (typeof headers?.get === "function") return headers.get(name);
    if (headers && typeof headers === "object") {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === name.toLowerCase()) return headers[key];
      }
    }
    return null;
  };
  const traceparent = get("traceparent");
  const parsed = parseTraceparent(traceparent);
  if (parsed) {
    return {
      traceId: parsed.traceId,
      parentId: parsed.parentId,
      sampled: parsed.sampled,
      incoming: traceparent,
      forward: buildTraceparent({ traceId: parsed.traceId, parentId: newSpanId(), sampled: parsed.sampled }),
    };
  }
  const amzn = traceparentFromAmzn(get("x-amzn-trace-id"));
  if (amzn) {
    return {
      traceId: amzn.traceId,
      parentId: amzn.parentId,
      sampled: amzn.sampled,
      incoming: get("x-amzn-trace-id"),
      forward: buildTraceparent({ traceId: amzn.traceId, parentId: newSpanId(), sampled: amzn.sampled }),
    };
  }
  const traceId = newTraceId();
  return {
    traceId,
    parentId: null,
    sampled: null,
    incoming: null,
    forward: buildTraceparent({ traceId, parentId: newSpanId(), sampled: false }),
  };
}

/**
 * Glob matcher for sampling-rule paths (`*` matches one segment, `**` any).
 *
 * @param {string} pattern
 * @param {string} path
 * @returns {boolean}
 */
export function matchGlob(pattern, path) {
  const regex = String(pattern ?? "")
    .split("/")
    .map((segment) => {
      if (segment === "**") return ".*";
      return segment
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*");
    })
    .join("/");
  return new RegExp(`^${regex}$`).test(String(path ?? ""));
}

/**
 * Decides whether to sample a request. Rules are evaluated in `priority`
 * order; the first match wins. Each rule: `{ priority, reservoirPerSec,
 * fixedRate, match: { host?, method?, path?, apiId?, stage? } }`. The
 * reservoir guarantees `reservoirPerSec` traces per second; beyond that the
 * `fixedRate` (0–1) applies. `random()` is injectable so tests seed it.
 *
 * @param {Array<object>} rules
 * @param {{ host?: string, method?: string, path?: string, apiId?: string, stage?: string }} request
 * @param {{ nowMs?: number, random?: () => number, reservoir?: Map<string, { windowSec: number, used: number }> }} [options={}]
 * @returns {{ sampled: boolean, rulePriority: number|null }}
 */
export function decideSampling(rules, request, { nowMs = Date.now(), random = Math.random, reservoir = new Map() } = {}) {
  const ordered = [...(rules ?? [])].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  for (const rule of ordered) {
    const match = rule.match ?? {};
    if (match.host && match.host !== request.host) continue;
    if (match.method && match.method !== request.method) continue;
    if (match.apiId && match.apiId !== request.apiId) continue;
    if (match.stage && match.stage !== request.stage) continue;
    if (match.path && !matchGlob(match.path, request.path ?? "/")) continue;
    const windowSec = Math.floor(nowMs / 1000);
    const key = String(rule.priority ?? 0);
    let bucket = reservoir.get(key);
    if (!bucket || bucket.windowSec !== windowSec) {
      bucket = { windowSec, used: 0 };
      reservoir.set(key, bucket);
    }
    if (bucket.used < (rule.reservoirPerSec ?? 0)) {
      bucket.used += 1;
      return { sampled: true, rulePriority: rule.priority ?? null };
    }
    if (random() < (rule.fixedRate ?? 0)) return { sampled: true, rulePriority: rule.priority ?? null };
    return { sampled: false, rulePriority: rule.priority ?? null };
  }
  return { sampled: false, rulePriority: null };
}

/** Default sampling rule: 1 req/s reservoir + 5 % (X-Ray default). */
export function defaultSamplingRules() {
  return [{ priority: 1, reservoirPerSec: 1, fixedRate: 0.05, match: {} }];
}

/**
 * Creates one span object.
 *
 * @param {{ traceId: string, name: string, kind?: string, parentId?: string|null,
 *   attributes?: Record<string, unknown>, startMs?: number }} options
 */
export function createSpan({ traceId, name, kind = "server", parentId = null, attributes = {}, startMs = Date.now() }) {
  return {
    traceId,
    spanId: newSpanId(),
    parentId,
    name,
    kind,
    attributes: { ...attributes },
    startMs,
    endMs: null,
    durationMs: null,
    status: "ok",
  };
}

/** Ends a span, setting `endMs`/`durationMs`. */
export function endSpan(span, endMs = Date.now()) {
  span.endMs = endMs;
  span.durationMs = Math.max(0, endMs - span.startMs);
  return span;
}

/**
 * Converts spans to OTLP/HTTP JSON (`/v1/traces`) payload shape.
 *
 * @param {Array<object>} spans
 * @param {{ serviceName?: string }} [options={}]
 */
export function spansToOtlp(spans, { serviceName = "pods-gateway" } = {}) {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
      scopeSpans: [{
        scope: { name: "pods-gateway-tracing" },
        spans: (spans ?? []).map((span) => ({
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentId ?? "",
          name: span.name,
          kind: span.kind === "client" ? 3 : 2,
          startTimeUnixNano: String(BigInt(Math.round(span.startMs)) * 1000000n),
          endTimeUnixNano: String(BigInt(Math.round(span.endMs ?? span.startMs)) * 1000000n),
          attributes: Object.entries(span.attributes ?? {}).map(([key, value]) => ({
            key,
            value: typeof value === "number"
              ? { doubleValue: value }
              : typeof value === "boolean"
                ? { boolValue: value }
                : { stringValue: String(value ?? "") },
          })),
          status: { code: span.status === "error" ? 2 : 1 },
        })),
      }],
    }],
  };
}

/**
 * Exports spans to an OTLP/HTTP endpoint in one batch.
 *
 * @param {Array<object>} spans
 * @param {{ endpoint: string, headers?: Record<string,string>, fetchImpl?: typeof fetch, serviceName?: string }} options
 * @returns {Promise<{ ok: boolean, status?: number }>}
 */
export async function exportSpansOtlp(spans, { endpoint, headers = {}, fetchImpl = globalThis.fetch, serviceName } = {}) {
  if (!endpoint || !spans || spans.length === 0) return { ok: true };
  const response = await fetchImpl(`${String(endpoint).replace(/\/$/, "")}/v1/traces`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(spansToOtlp(spans, { serviceName })),
  });
  return { ok: response.ok, status: response.status };
}
