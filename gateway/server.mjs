/**
 * Gateway runtime host (S05 §5).
 *
 * `node:http` server (TLS terminated by the platform load balancer, or
 * `node:https` when S11 mTLS is enabled). Converts `IncomingMessage` → Web
 * `Request` (streaming body, honors client abort) and Web `Response` →
 * `ServerResponse` (streaming, `flushHeaders` for S09). Default port
 * `PORT=4000`. Health: `GET /_pods/health` (liveness) and `/_pods/ready`
 * (artifact store reachable). Never matches under an API host.
 *
 * `createGatewayServer({ loader, ports })` is the test factory: tests inject
 * an in-memory loader with fixture artifacts and stage pointers instead of
 * Supabase. Production wires `createSupabaseLoader` + real ports
 * (`fetch` via undici with the SSRF lookup, `kv` redis or memory,
 * `secrets` vault resolver, `events` S10 sink no-op, `clock`).
 *
 * @module gateway/server
 */

import http from "node:http";
import { handle, createPorts } from "../lib/gateway/core/index.mjs";
import { renderGatewayError } from "../lib/gateway/core/gateway-responses.mjs";
import { MemoryKvStore } from "../lib/gateway/state/memory-kv.mjs";
import { createEventSink } from "../lib/gateway/core/observe/event.mjs";
import { createMetricsAggregator } from "../lib/gateway/core/observe/metrics.mjs";

/**
 * Default S10 event sink for the gateway host (additive wiring).
 *
 * The engine's emit phase delivers `{ event, accessLog, executionLog, spans }`
 * off the response path. This sink fans out to in-memory consumers that never
 * block: a per-minute metrics aggregator (flushed every 60 s to
 * `ports.metricsWriter` when provided), an access-log batcher (1 s or 500
 * rows to `ports.logsWriter` when provided) and a trace-span forwarder
 * (`ports.traceWriter` when provided). With no writers configured everything
 * stays in memory and is observable via `sink.metrics` (tests, dev).
 *
 * @param {{ metricsWriter?: { upsertMinuteRows(rows: Array<object>): Promise<void> }|null,
 *   logsWriter?: { insertAccessLogs(rows: Array<object>): Promise<void>,
 *   insertExecutionLogs(rows: Array<object>): Promise<void> }|null,
 *   traceWriter?: { insertSpans(rows: Array<object>): Promise<void> }|null,
 *   log?: Function }} [writers={}]
 */
export function createGatewaySink({ metricsWriter = null, logsWriter = null, traceWriter = null, log = null } = {}) {
  const metrics = createMetricsAggregator();
  const accessBatch = [];
  const executionBatch = [];
  const noop = () => {};
  const warn = typeof log === "function" ? log : noop;

  async function flushMetrics() {
    if (!metricsWriter || typeof metricsWriter.upsertMinuteRows !== "function") return;
    const rows = metrics.flush();
    if (rows.length === 0) return;
    try {
      await metricsWriter.upsertMinuteRows(rows);
    } catch (error) {
      warn("gateway metrics flush failed", error);
    }
  }

  async function flushLogs() {
    if (!logsWriter) return;
    const access = accessBatch.splice(0, accessBatch.length);
    const execution = executionBatch.splice(0, executionBatch.length);
    try {
      if (access.length > 0 && typeof logsWriter.insertAccessLogs === "function") {
        await logsWriter.insertAccessLogs(access);
      }
    } catch (error) {
      warn("gateway access-log flush failed", error);
    }
    try {
      if (execution.length > 0 && typeof logsWriter.insertExecutionLogs === "function") {
        await logsWriter.insertExecutionLogs(execution);
      }
    } catch (error) {
      warn("gateway execution-log flush failed", error);
    }
  }

  const sink = createEventSink({
    consumers: [
      (payload) => {
        const { event, accessLog, executionLog, spans } = payload ?? {};
        try {
          if (event) metrics.record(event);
        } catch (error) {
          warn("gateway metrics record failed", error);
        }
        try {
          if (accessLog) {
            accessBatch.push(accessLog);
            if (accessBatch.length >= 500) void flushLogs();
          }
          if (executionLog) executionBatch.push(executionLog);
        } catch (error) {
          warn("gateway log buffer failed", error);
        }
        try {
          if (spans?.length > 0 && typeof traceWriter?.insertSpans === "function") {
            traceWriter.insertSpans(spans.map((span) => ({ ...span }))).catch((error) => warn("gateway trace flush failed", error));
          }
        } catch (error) {
          warn("gateway trace forward failed", error);
        }
      },
    ],
  });
  const metricsTimer = setInterval(() => {
    void flushMetrics();
  }, 60000);
  if (typeof metricsTimer.unref === "function") metricsTimer.unref();
  const logsTimer = setInterval(() => {
    if (accessBatch.length > 0 || executionBatch.length > 0) void flushLogs();
  }, 1000);
  if (typeof logsTimer.unref === "function") logsTimer.unref();
  return Object.assign(sink, {
    metrics,
    flushMetrics,
    flushLogs,
    /** Stops the background flush timers (tests, shutdown). */
    close() {
      clearInterval(metricsTimer);
      clearInterval(logsTimer);
    },
  });
}

/**
 * Reads a Node request body into bytes (honors client abort via `signal`).
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {AbortSignal} signal
 * @returns {Promise<Uint8Array|null>}
 */
function readNodeBody(req, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(chunks.length === 0 ? null : Buffer.concat(chunks)));
    req.on("error", reject);
    signal.addEventListener("abort", () => {
      try {
        req.destroy();
      } catch {
        // Best-effort.
      }
      resolve(null);
    }, { once: true });
  });
}

/**
 * Builds a Web Request from a Node request + resolved stripped path.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {string} strippedPath
 * @param {Uint8Array|null} body
 * @returns {Request}
 */
function toWebRequest(req, strippedPath, body) {
  const host = req.headers.host ?? "localhost";
  const query = req.url?.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  const url = `http://${host}${strippedPath}${query}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else {
      headers.append(name, value);
    }
  }
  const method = (req.method ?? "GET").toUpperCase();
  const init = { method, headers };
  if (body && body.byteLength > 0 && method !== "GET" && method !== "HEAD") {
    init.body = body;
    init.duplex = "half";
  }
  return new Request(url, init);
}

/**
 * Sends a Web Response over a Node ServerResponse (streaming).
 *
 * @param {Response} response
 * @param {import("node:http").ServerResponse} res
 */
async function sendWebResponse(response, res) {
  const headers = {};
  for (const [name, value] of response.headers.entries()) headers[name] = value;
  const body = response.body;
  res.writeHead(response.status, headers);
  if (typeof res.flushHeaders === "function") {
    try {
      res.flushHeaders();
    } catch {
      // Best-effort (S09 streaming relies on this).
    }
  }
  if (!body) {
    res.end();
    return;
  }
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.destroyed) break;
      res.write(value);
    }
  } finally {
    reader.releaseLock();
  }
  res.end();
}

function gatewayErrorResponse(error, ctx) {
  if (error && typeof error.status === "number") {
    const type = error.type ?? (error.status === 404 ? "RESOURCE_NOT_FOUND" : "DEFAULT_5XX");
    const message = error.message ?? "Internal server error";
    return renderGatewayError({ type, message }, ctx ?? {});
  }
  return renderGatewayError({ type: "DEFAULT_5XX", message: "Internal server error" }, ctx ?? {});
}

/**
 * Creates a gateway server. Does not listen until `start()` is called.
 *
 * @param {{ loader: { resolve(host: string, path: string): Promise<object> },
 *   ports?: object, clock?: { now(): number }, onRequest?: (info: object) => void }} [options={}]
 * @returns {{ server: import("node:http").Server, start(port?: number): Promise<number>,
 *   close(): Promise<void>, url: string|null, inFlight: Set<object> }}
 */
export function createGatewayServer({ loader, ports = {}, clock = null, onRequest = null } = {}) {
  if (!loader || typeof loader.resolve !== "function") {
    throw new TypeError("createGatewayServer requires a loader with resolve(host, path).");
  }
  const usePorts = createPorts({
    kv: ports.kv ?? new MemoryKvStore({ clock: clock ?? { now: () => Date.now() } }),
    fetch: ports.fetch ?? globalThis.fetch,
    secrets: ports.secrets ?? { async resolve() { throw new Error("No secret resolver configured."); } },
    // S10: the gateway host injects a real bounded sink (metrics aggregation +
    // log batching off the response path); explicit ports.events still wins.
    events: ports.events ?? createGatewaySink({
      metricsWriter: ports.metricsWriter ?? null,
      logsWriter: ports.logsWriter ?? null,
      traceWriter: ports.traceWriter ?? null,
      log: ports.log ?? (() => {}),
    }),
    clock: clock ?? ports.clock ?? { now: () => Date.now() },
    log: ports.log ?? (() => {}),
    ...ports,
  });
  const inFlight = new Set();
  let url = null;
  let ready = true;

  const server = http.createServer(async (req, res) => {
    const record = { req, res, startedAt: Date.now() };
    inFlight.add(record);
    const controller = new AbortController();
    req.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const pathname = (req.url ?? "/").split("?")[0] || "/";
      if (req.method === "GET" && (pathname === "/_pods/health" || pathname === "/_pods/ready")) {
        if (pathname === "/_pods/ready" && ready === false) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const host = req.headers.host ?? "";
      let resolved;
      try {
        resolved = await loader.resolve(host, pathname);
      } catch (error) {
        const status = error?.status ?? (error?.type === "RESOURCE_NOT_FOUND" ? 404 : 500);
        if (status === 503) {
          const response = new Response(JSON.stringify({ message: "Service Unavailable" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
          await sendWebResponse(response, res);
          return;
        }
        const ctx = { requestId: "", context: { requestId: "" } };
        const type = error?.type ?? (status === 404 ? "RESOURCE_NOT_FOUND" : status === 403 ? "MISSING_AUTHENTICATION_TOKEN" : "DEFAULT_5XX");
        const message = error?.message ?? "Internal server error";
        await sendWebResponse(renderGatewayError({ type, message }, ctx), res);
        return;
      }
      const body = await readNodeBody(req, controller.signal);
      const webRequest = toWebRequest(req, resolved.basePathStripped, body);
      const artifact = {
        ...resolved.artifact,
        stage: resolved.stage,
        stageVariables: resolved.stageVariables ?? resolved.artifact?.stageVariables ?? {},
        deploymentId: resolved.deploymentId ?? resolved.artifact?.deploymentId ?? null,
      };
      const ctxPorts = { ...usePorts, signal: controller.signal };
      // The engine reads `ctx.signal` for client-abort linkage (S04).
      const { buildContext, runPipeline } = await import("../lib/gateway/core/index.mjs");
      const ctx = buildContext(webRequest, artifact, ctxPorts);
      ctx.signal = controller.signal;
      ctx.requestPath = resolved.basePathStripped;
      ctx.basePathStripped = resolved.basePathStripped;
      ctx.stage = resolved.stage;
      ctx.apiPublicId = resolved.apiPublicId;
      // $context.path is the full path with the stage (AWS parity).
      if (ctx.context) {
        ctx.context.path = pathname.split("?")[0];
        ctx.context.stage = resolved.stage;
        ctx.context.deploymentId = artifact.deploymentId ?? "";
      }
      // Stash the original ports (with abort signal) for phases.
      ctx.ports = ctxPorts;
      const response = await runPipeline(ctx);
      try {
        onRequest?.({ apiPublicId: resolved.apiPublicId, stage: resolved.stage, status: response.status });
      } catch {
        // Observability must never break responses.
      }
      await sendWebResponse(response, res);
    } catch (error) {
      try {
        await sendWebResponse(gatewayErrorResponse(error), res);
      } catch {
        try {
          res.destroy();
        } catch {
          // Last resort.
        }
      }
    } finally {
      inFlight.delete(record);
    }
  });

  return {
    server,
    inFlight,
    get url() {
      return url;
    },
    /**
     * Starts listening on an ephemeral port (or `port`).
     *
     * @param {number} [port=0]
     * @returns {Promise<number>} The bound port.
     */
    async start(port = 0) {
      const listenPort = port || Number(process.env.PORT ?? 4000);
      // When tests pass 0, bind ephemeral (port 0 → random).
      const target = port === 0 ? 0 : listenPort;
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(target, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address();
      url = `http://127.0.0.1:${address.port}`;
      return address.port;
    },
    /**
     * Graceful shutdown: stop accepting, drain in-flight ≤ 30 s.
     *
     * @param {{ timeoutMs?: number }} [options={}]
     */
    async close({ timeoutMs = 30000 } = {}) {
      await new Promise((resolve) => server.close(resolve));
      if (inFlight.size === 0) return;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (inFlight.size === 0) return;
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    /** Test hook: mark the artifact store unreachable (`/_pods/ready` → 503). */
    setReady(next) {
      ready = next;
    },
  };
}

/**
 * Standalone entry: wires the Supabase loader + real ports and listens on
 * `PORT` (default 4000). `PODS_GATEWAY_PATH_ROUTING=1` enables path routing.
 */
export async function main() {
  const { createSupabaseLoader } = await import("./loader.mjs");
  const { kvFromEnv } = await import("../lib/gateway/state/kv.mjs");
  const kv = await kvFromEnv(process.env).catch(() => new MemoryKvStore({}));
  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let loader;
  if (url && serviceKey) {
    const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });
    loader = createSupabaseLoader({ supabase, kv });
  } else {
    const { createMemoryLoader } = await import("./loader.mjs");
    loader = createMemoryLoader({ kv });
  }
  const gateway = createGatewayServer({ loader, ports: { kv } });
  const port = Number(process.env.PORT ?? 4000);
  await gateway.start(port);
  console.log(`gateway listening on :${port} (pathRouting=${process.env.PODS_GATEWAY_PATH_ROUTING ?? "0"})`);

  const shutdown = async () => {
    await gateway.close({ timeoutMs: 30000 });
    await kv.close?.().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  return gateway;
}

const invokedAsMain = process.argv[1] && String(process.argv[1]).endsWith("gateway/server.mjs");
if (invokedAsMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
