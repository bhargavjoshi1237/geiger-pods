/**
 * `emit` phase (pipeline row 20 — access log, execution log, metrics, trace span).
 * Post-response, never blocks. Owned by S10.
 *
 * Builds the S10 §1 request event after the response completes and fans it
 * out through `ports.events.emit` via `queueMicrotask`/`setImmediate`, never
 * on the response path. Test-invoke traffic is excluded. Access-log lines,
 * execution-log rows and trace decisions are derived here from
 * `ctx.stageSettings` (populated by the runtime/tests; the compiled artifact
 * carries no mutable stage settings) and attached to the event so each
 * consumer (metrics aggregator, log writers, trace exporter) fails
 * independently downstream.
 *
 * @module lib/gateway/core/phases/emit
 */

import { buildRequestEvent } from "../observe/event.mjs";
import { renderAccessLog, toAccessLogRow } from "../observe/access-log.mjs";
import { toExecutionLogRow, toLogLines, buildVocabularyTranscript } from "../observe/execution-log.mjs";
import {
  createSpan,
  decideSampling,
  defaultSamplingRules,
  endSpan,
  resolveInboundTrace,
} from "../observe/tracing.mjs";

/** Phase name as listed in the pipeline table (§3). */
export const name = "emit";

/**
 * Reads observability settings for the current stage. The compiled artifact
 * is immutable, so mutable stage settings travel on `ctx.stageSettings`
 * (set by the runtime loader/tests), with `artifact.stageSettings[stage]` as
 * a fallback and safe defaults otherwise.
 *
 * @param {object} ctx - Pipeline context.
 * @returns {Record<string, any>}
 */
export function stageSettingsOf(ctx) {
  const stage = ctx?.stage ?? ctx?.context?.stage ?? ctx?.artifact?.stage ?? "";
  return (
    ctx?.stageSettings ??
    ctx?.artifact?.stageSettings?.[stage] ??
    {}
  );
}

function numberOrNull(value) {
  const num = Number(value);
  return value === "" || value === null || value === undefined || !Number.isFinite(num) ? null : num;
}

/**
 * Derives access-log, execution-log and trace payloads and attaches them to
 * the event. Never throws.
 *
 * @param {object} ctx - Pipeline context.
 * @param {object} event - S10 §1 request event (mutated in place).
 * @param {{ now?: number }} [options={}]
 */
export function attachObservability(ctx, event, { now = Date.now() } = {}) {
  const settings = stageSettingsOf(ctx) ?? {};

  // Access log (§3): render only when enabled for the stage.
  try {
    const accessLog = settings.accessLog ?? settings.access_log ?? null;
    if (accessLog?.enabled === true && typeof accessLog.format === "string" && accessLog.format.length > 0) {
      const line = renderAccessLog(accessLog.format, ctx);
      event.accessLog = {
        line,
        row: toAccessLogRow(event, line),
        destinations: Array.isArray(accessLog.destinations) && accessLog.destinations.length > 0
          ? accessLog.destinations
          : ["pods"],
      };
    } else {
      event.accessLog = null;
    }
  } catch {
    event.accessLog = null;
  }

  // Execution log (§4): per-method/route level with stage default.
  try {
    const routeKey = event.routeKey || event.resourcePath || "";
    const methodSettings = settings.methodSettings ?? settings.method_settings ?? {};
    const routeSettings = settings.routeSettings ?? settings.route_settings ?? {};
    const routeConfig = methodSettings[routeKey] ?? routeSettings[routeKey] ?? {};
    const loggingLevel = routeConfig.loggingLevel ?? settings.loggingLevel ?? "OFF";
    const dataTraceEnabled = routeConfig.dataTraceEnabled ?? settings.dataTraceEnabled ?? false;
    if (loggingLevel !== "OFF") {
      const collected = Array.isArray(ctx?.execLog?.lines)
        ? ctx.execLog.lines
        : Array.isArray(ctx?.executionLines)
          ? ctx.executionLines
          : null;
      const lines = collected ?? toLogLines(buildVocabularyTranscript({
        extendedRequestId: ctx?.context?.extendedRequestId ?? event.extendedRequestId ?? "",
        httpMethod: event.httpMethod ?? "",
        resourcePath: event.resourcePath ?? "",
        apiKeyId: event.apiKeyId ?? null,
        cache: event.cache ?? null,
        throttled: event.throttled ?? false,
        endpointUri: ctx?.endpointUri ?? null,
        integrationLatencyMs: event.integrationLatencyMs ?? null,
        integrationStatus: ctx?.context?.integration?.integrationStatus ?? event.status ?? null,
        status: event.status ?? null,
        error: event.errorType ? `Execution failed: ${event.errorType}` : null,
      }, { dataTraceEnabled }));
      event.executionLog = toExecutionLogRow(event, lines, { loggingLevel });
    } else {
      event.executionLog = null;
    }
  } catch {
    event.executionLog = null;
  }

  // Tracing (§5): resolve inbound context, sample, build spans.
  try {
    const tracingEnabled = settings.tracingEnabled ?? settings.tracing_enabled ?? false;
    const inbound = resolveInboundTrace(ctx?.request?.headers ?? {});
    event.traceId = inbound.traceId;
    if (ctx?.context && !ctx.context.traceId) ctx.context.traceId = inbound.traceId;
    ctx.traceForward = inbound.forward;
    if (tracingEnabled === true) {
      const rules = Array.isArray(settings.samplingRules) && settings.samplingRules.length > 0
        ? settings.samplingRules
        : defaultSamplingRules();
      const decision = decideSampling(rules, {
        host: ctx?.request ? new URL(ctx.request.url).hostname : "",
        method: event.httpMethod ?? "GET",
        path: ctx?.request ? new URL(ctx.request.url).pathname : "/",
        apiId: event.apiPublicId ?? "",
        stage: event.stage ?? "",
      }, { nowMs: now, random: settings.samplingSeed ?? Math.random });
      const spans = [];
      if (decision.sampled) {
        const root = createSpan({
          traceId: inbound.traceId,
          name: "gateway",
          kind: "server",
          parentId: inbound.parentId,
          attributes: {
            "http.method": event.httpMethod ?? "",
            "http.route": event.routeKey || event.resourcePath || "",
            "http.status_code": event.status ?? 0,
            "pods.stage": event.stage ?? "",
            "pods.canary": Boolean(event.canary),
          },
          startMs: ctx?.startTime ?? now,
        });
        if (event.integrationLatencyMs != null) {
          const child = createSpan({
            traceId: inbound.traceId,
            name: "integration",
            kind: "client",
            parentId: root.spanId,
            attributes: { "http.status_code": event.status ?? 0 },
            startMs: root.startMs,
          });
          endSpan(child, root.startMs + event.integrationLatencyMs);
          spans.push(child);
        }
        endSpan(root, now);
        spans.unshift(root);
      }
      event.trace = {
        traceId: inbound.traceId,
        parentId: inbound.parentId,
        sampled: decision.sampled,
        rulePriority: decision.rulePriority,
        forward: inbound.forward,
        spans,
      };
    } else {
      event.trace = { traceId: inbound.traceId, parentId: inbound.parentId, sampled: false, rulePriority: null, forward: inbound.forward, spans: [] };
    }
  } catch {
    event.trace = event.trace ?? null;
  }

  // Detailed-metrics dimension flag for the aggregator.
  try {
    const routeKey = event.routeKey || event.resourcePath || "";
    const methodSettings = settings.methodSettings ?? settings.method_settings ?? {};
    const routeSettings = settings.routeSettings ?? settings.route_settings ?? {};
    const routeConfig = methodSettings[routeKey] ?? routeSettings[routeKey] ?? {};
    event.detailedMetrics = Boolean(
      routeConfig.metricsEnabled ?? routeConfig.detailedMetricsEnabled ?? settings.detailedMetrics ?? false,
    );
  } catch {
    event.detailedMetrics = false;
  }
}

/**
 * Builds the request event after the response and emits it off-tick.
 * Returning a value is intentionally impossible: this phase never answers.
 *
 * @param {object} ctx - Pipeline context (with `response` set).
 * @returns {Promise<undefined>}
 */
export async function run(ctx) {
  try {
    if (!ctx || ctx.testInvoke === true || ctx.artifact?.testInvoke === true) return undefined;
    const response = ctx.response ?? null;
    const ports = ctx.ports ?? {};
    const clock = ports.clock ?? { now: () => Date.now() };
    const task = () => {
      try {
        const now = clock.now();
        const startTime = ctx.startTime ?? now;
        const event = buildRequestEvent(ctx, response, {
          latencyMs: Math.max(0, now - startTime),
          integrationLatencyMs: ctx.integrationLatencyMs ?? numberOrNull(ctx.context?.integration?.latency) ?? numberOrNull(ctx.context?.integrationLatency),
          authorizerLatencyMs: ctx.authorizerLatencyMs ?? numberOrNull(ctx.context?.authorizer?.latency),
          requestBytes: ctx.requestBytes ?? null,
          responseBytes: ctx.responseBytes ?? null,
        });
        attachObservability(ctx, event, { now });
        ctx.requestEvent = event;
        try {
          ports.events?.emit(event);
        } catch {
          // The sink never breaks the response path.
        }
      } catch {
        // Emit must never block or break the response.
      }
    };
    if (typeof queueMicrotask === "function") queueMicrotask(task);
    else if (typeof setImmediate === "function") setImmediate(task);
    else task();
  } catch {
    // Emit must never block or break the response.
  }
  return undefined;
}
