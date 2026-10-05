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
import { createControlDb } from "../lib/control/supabase-db.mjs";
import { withAuthTables } from "../lib/control/auth-db.mjs";
import { withUsageDb } from "../lib/control/usage-db.mjs";
import { withObservabilityTables } from "../lib/control/observe-db.mjs";
import { createSigningPorts } from "../lib/control/signing-credentials.mjs";
import { resolveSecretRef } from "../lib/vault/secrets.mjs";
import { loadVaultKeys } from "../lib/vault/keys.mjs";
import { attachUsage } from "../lib/control/usage-loader.mjs";
import { createHub } from "../lib/gateway/core/integrations/connector.mjs";

/**
 * Default S10 event sink for the gateway host (additive wiring).
 *
 * The engine's emit phase delivers the S10 request event directly (with
 * `accessLog = { line, row }`, `executionLog = row|null`,
 * `trace = { spans }`) off the response path. Older callers may pass
 * `{ event, accessLog, executionLog, spans }`; both shapes are accepted.
 * This sink fans out to in-memory consumers that never
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
        // The emit phase passes the request event directly; older callers
        // pass `{ event, accessLog, executionLog, spans }`. Support both so
        // metrics/logs/traces reach Postgres in production.
        const event = payload?.event ?? payload ?? null;
        const rawAccess = payload?.accessLog ?? event?.accessLog ?? null;
        const rawExecution = payload?.executionLog ?? event?.executionLog ?? null;
        const rawSpans = payload?.spans ?? payload?.trace?.spans ?? event?.trace?.spans ?? null;
        try {
          if (event) metrics.record(event);
        } catch (error) {
          warn("gateway metrics record failed", error);
        }
        try {
          const accessRow = rawAccess?.row ?? rawAccess ?? null;
          if (accessRow && (accessRow.project_id || accessRow.projectId || accessRow.line || accessRow.request_id)) {
            accessBatch.push(accessRow);
            if (accessBatch.length >= 500) void flushLogs();
          }
          const executionRow = rawExecution?.row ?? rawExecution ?? null;
          if (executionRow) executionBatch.push(executionRow);
        } catch (error) {
          warn("gateway log buffer failed", error);
        }
        try {
          const spans = Array.isArray(rawSpans) ? rawSpans : [];
          if (spans.length > 0 && typeof traceWriter?.insertSpans === "function") {
            const enriched = spans.map((span) => {
              const copy = { ...(span ?? {}) };
              if ((copy.projectId ?? copy.project_id) === undefined) {
                copy.projectId = event?.projectId ?? event?.project_id ?? "";
              }
              if ((copy.apiId ?? copy.api_id) === undefined) {
                copy.apiId = event?.apiId ?? event?.api_id ?? "";
              }
              if (copy.stage === undefined) copy.stage = event?.stage ?? "";
              if ((copy.requestId ?? copy.request_id) === undefined) {
                copy.requestId = event?.requestId ?? event?.request_id ?? null;
              }
              if ((copy.traceId ?? copy.trace_id) === undefined && event?.traceId) {
                copy.traceId = event.traceId;
              }
              return copy;
            });
            traceWriter.insertSpans(enriched).catch((error) => warn("gateway trace flush failed", error));
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
      // S09: client disconnect aborts the upstream within 100 ms — cancel
      // the engine stream (which aborts the upstream fetch) instead of just
      // breaking the write loop.
      if (res.destroyed) {
        try {
          await reader.cancel();
        } catch {
          // Best-effort.
        }
        break;
      }
      res.write(value);
    }
  } catch {
    // Client disconnect mid-stream: cancel upstream, then finish.
    try {
      await reader.cancel();
    } catch {
      // Best-effort.
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Best-effort when cancelled.
    }
  }
  if (!res.destroyed) res.end();
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
      if (typeof usePorts.secrets?.forProject === "function") {
        ctxPorts.secrets = usePorts.secrets.forProject(artifact.projectId ?? null);
      }
      // The engine reads `ctx.signal` for client-abort linkage (S04).
      const { buildContext, runPipeline } = await import("../lib/gateway/core/index.mjs");
      const ctx = buildContext(webRequest, artifact, ctxPorts);
      ctx.signal = controller.signal;
      ctx.requestPath = resolved.basePathStripped;
      ctx.basePathStripped = resolved.basePathStripped;
      ctx.stage = resolved.stage;
      ctx.apiPublicId = resolved.apiPublicId;
      // S09: canary + stage cache travel from the loader (memory fixture or
      // Supabase stage row) onto the pipeline context.
      if (resolved.canary) ctx.canaryConfig = resolved.canary;
      if (resolved.canaryArtifact) ctx.canaryArtifact = resolved.canaryArtifact;
      if (resolved.stageCache) ctx.stageCache = resolved.stageCache;
      // $context.path is the full path with the stage (AWS parity).
      if (ctx.context) {
        ctx.context.path = pathname.split("?")[0];
        ctx.context.stage = resolved.stage;
        ctx.context.deploymentId = artifact.deploymentId ?? "";
      }
      // Stash the original ports (with abort signal) for phases.
      ctx.ports = ctxPorts;
      // S08: attach per-request usage (pepper + DB read-through + project/stage
      // config) so keys work without a redeploy. Best-effort: never breaks
      // responses; throttle defaults and the KV cache still apply on failure.
      try {
        const loader = ctxPorts.usage ?? ctxPorts.kv?.usage ?? null;
        const pepper = ctxPorts.keyPepper ?? process.env.PODS_KEY_PEPPER ?? "";
        if (loader && typeof loader.loadKeyRecord === "function") {
          let requestUsage = {};
          try {
            if (typeof loader.loadRequestUsage === "function") {
              requestUsage = await loader.loadRequestUsage({
                apiId: artifact.apiId ?? "",
                stage: resolved.stage ?? artifact.stage ?? "",
                projectId: artifact.projectId ?? "",
              });
            }
          } catch {
            requestUsage = {};
          }
          ctx.usage = {
            ...(ctx.usage ?? {}),
            pepper,
            lookup: (hmacHex) => loader.loadKeyRecord(hmacHex),
            ...requestUsage,
          };
        } else if (pepper && !ctx.usage) {
          ctx.usage = { pepper };
        } else if (pepper && ctx.usage && !ctx.usage.pepper) {
          ctx.usage.pepper = pepper;
        }
      } catch {
        // Usage is best-effort; defaults still apply.
      }
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
 * In-process secret cache TTL: 60 s (S04 §5). Plaintext lives only in this
 * `Map`, never in KV, and is never logged.
 */
export const PRODUCTION_SECRET_CACHE_TTL_MS = 60_000;

/**
 * Maximum entries in the production secrets cache (bounds memory).
 */
export const PRODUCTION_SECRET_CACHE_MAX = 1000;

/**
 * Builds the production gateway ports (S05 wiring, B1).
 *
 * Testable with no side effects at import: pure construction from
 * `{ env, supabase, kv }` (plus optional `db`, `clock`, `log`, `fetch` for
 * tests). `supabase` is the service-role Supabase client; when it already
 * looks like a control `db` (has `getSecretById`, as in tests) it is used
 * directly, otherwise it is wrapped via `createControlDb` +
 * `withAuthTables`/`withUsageDb`/`withObservabilityTables` (read-only for
 * config, insert-only for telemetry).
 *
 * Wires:
 * - `secrets.resolve(ref)` via `resolveSecretRef(db, ref, { keys })` with an
 *   in-process 60 s TTL cache (never in KV, never logged).
 * - `signingCredentials`/`signingPolicies` via `createSigningPorts(db)`
 *   (always both — production never relies on the authorize phase's
 *   "valid signature is sufficient" test convenience).
 * - `kv` with the S08 usage loader attached (`attachUsage`, i.e.
 *   `kv.usage.loadKeyRecord` + `loadRequestUsage`) and `keyPepper` from
 *   `PODS_KEY_PEPPER` for DB read-through on KV miss.
 * - `metricsWriter`/`logsWriter`/`traceWriter` from the observability tables
 *   (matching `createGatewaySink`).
 * - `connectorHub` via `createHub` (S04 private integrations).
 *
 * In production (`NODE_ENV=production`) fails fast with a clear error when
 * required env is missing (`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`,
 * `PODS_KEY_PEPPER`, vault keys) and refuses to start when
 * `PODS_ALLOW_LOOPBACK` is set (F4). In non-production missing env falls
 * back to throwing stubs (as today) so `main()` can use the memory loader.
 *
 * @param {{ env?: Record<string,string|undefined>, supabase?: object|null, kv: object,
 *   db?: object|null, clock?: { now(): number }|null, log?: Function|null,
 *   fetch?: typeof fetch|null, fetchFn?: typeof fetch|null }} [options={}]
 * @returns {{ kv: object, fetch: typeof fetch, secrets: object,
 *   signingCredentials: object, signingPolicies: object, keyPepper: string,
 *   connectorHub: object, metricsWriter: object, logsWriter: object,
 *   traceWriter: object, usage: object, clock: object, log: Function }}
 */
export function createProductionPorts({ env = process.env, supabase = null, kv = null, db = null, clock = null, log = null, fetch: fetchOpt = null, fetchFn = null } = {}) {
  const effectiveEnv = env ?? process.env;
  const isProd = effectiveEnv?.NODE_ENV === "production";
  if (!kv || typeof kv.get !== "function") {
    throw new TypeError("createProductionPorts requires kv (a KvStore).");
  }
  // F4: production must refuse the SSRF test escape hatch.
  const loopbackRaw = effectiveEnv?.PODS_ALLOW_LOOPBACK;
  if (isProd && loopbackRaw !== undefined && loopbackRaw !== null && String(loopbackRaw) !== "" && String(loopbackRaw) !== "0") {
    throw new Error("PODS_ALLOW_LOOPBACK must not be set when NODE_ENV=production (F4).");
  }
  if (isProd) {
    const url = effectiveEnv?.SUPABASE_URL ?? effectiveEnv?.NEXT_PUBLIC_SUPABASE_URL;
    if (!url) {
      throw new Error("SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) is required when NODE_ENV=production.");
    }
    if (!effectiveEnv?.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is required when NODE_ENV=production.");
    }
    if (!effectiveEnv?.PODS_KEY_PEPPER) {
      throw new Error("PODS_KEY_PEPPER is required when NODE_ENV=production.");
    }
    try {
      loadVaultKeys(effectiveEnv);
    } catch (error) {
      throw new Error(`Vault keys are required when NODE_ENV=production: ${error?.message ?? error}`);
    }
  }
  const useClock = clock ?? { now: () => Date.now() };
  const useLog = typeof log === "function" ? log : (() => {});
  const useFetch = fetchOpt ?? fetchFn ?? globalThis.fetch;
  const keyPepper = effectiveEnv?.PODS_KEY_PEPPER ?? "";

  // Resolve the control db: explicit `db`, a control-db fake passed as
  // `supabase` (tests), or a real Supabase client wrapped with the S02/S07/
  // S08/S10 table helpers. In non-production without any db, use a stub that
  // fails closed (as today) so the memory loader still works.
  let controlDb = db ?? null;
  const candidate = controlDb ?? supabase ?? null;
  if (controlDb) {
    // Explicit db wins as-is.
  } else if (candidate && typeof candidate.getSecretById === "function") {
    controlDb = candidate;
  } else if (candidate && (typeof candidate.schema === "function" || typeof candidate.from === "function")) {
    const base = createControlDb(candidate, { service: candidate });
    withAuthTables(base, candidate);
    const withUsage = withUsageDb(base, candidate);
    withObservabilityTables(withUsage, candidate);
    controlDb = withUsage;
  } else if (isProd) {
    throw new Error("supabase client is required when NODE_ENV=production.");
  } else {
    controlDb = {
      async getSecretById() { return null; },
      async listSecretVersions() { return []; },
      async getSecretVersionEnvelope() { return null; },
      async getSigningCredentialByKey() { return null; },
      async listSigningPolicies() { return []; },
      async updateSigningCredential() { return null; },
      async getApiKeyByHmac() { return null; },
      async getApiKeyById() { return null; },
      async listPlansForKey() { return []; },
      async getPlanById() { return null; },
      async listPlanStages() { return []; },
      async listQuotaAdjustments() { return []; },
      async getProjectSettings() { return null; },
      async getStageByName() { return null; },
    };
  }

  // Vault keys for the secrets + signing vault paths. In non-production
  // without configured keys, resolve throws on use (as today) instead of at
  // startup.
  let vaultKeys = null;
  try {
    vaultKeys = loadVaultKeys(effectiveEnv);
  } catch {
    try {
      vaultKeys = loadVaultKeys(process.env);
    } catch {
      vaultKeys = null;
    }
  }

  const secretCache = new Map();
  // Secrets resolve only within the artifact's project: `forProject` binds
  // the scope per request, and a ref to another project's secret is a 404.
  const secrets = {
    async resolve(ref, { projectId = null } = {}) {
      if (!projectId) throw new Error("Secret resolution requires a project scope.");
      const now = useClock?.now?.() ?? Date.now();
      const cacheKey = JSON.stringify([projectId, ref]);
      const cached = secretCache.get(cacheKey);
      if (cached && cached.expiresAt > now) return cached.value;
      if (!vaultKeys) throw new Error("No secret resolver configured.");
      // Never logged, never in KV: in-process TTL only.
      const resolved = await resolveSecretRef(controlDb, ref, { keys: vaultKeys, projectId });
      secretCache.set(cacheKey, { value: resolved, expiresAt: now + PRODUCTION_SECRET_CACHE_TTL_MS });
      if (secretCache.size > PRODUCTION_SECRET_CACHE_MAX) {
        const oldest = secretCache.keys().next().value;
        secretCache.delete(oldest);
      }
      return resolved;
    },
    forProject(projectId) {
      return { resolve: (ref) => secrets.resolve(ref, { projectId }) };
    },
  };

  const vaultForSigning = {
    async revealSecret(ref) {
      if (!vaultKeys) throw new Error("No secret resolver configured.");
      const resolved = await resolveSecretRef(controlDb, ref, { keys: vaultKeys });
      return String(resolved?.value?.value ?? "");
    },
  };
  // Production always wires both signing ports (the authorize phase's
  // "valid signature is sufficient" fallback is test-only).
  const { signingCredentials, signingPolicies } = createSigningPorts(controlDb, { vault: vaultForSigning });

  const kvWithUsage = attachUsage(kv, { db: controlDb, clock: useClock });

  const connectorHub = createHub(isProd ? { sendPing: true } : {});

  return {
    kv: kvWithUsage,
    fetch: useFetch,
    secrets,
    signingCredentials,
    signingPolicies,
    keyPepper,
    connectorHub,
    metricsWriter: controlDb,
    logsWriter: controlDb,
    traceWriter: controlDb,
    usage: kvWithUsage.usage,
    clock: useClock,
    log: useLog,
  };
}

/**
 * Standalone entry: wires the Supabase loader + real ports and listens on
 * `PORT` (default 4000). `PODS_GATEWAY_PATH_ROUTING=1` enables path routing.
 */
export async function main() {
  const isProd = process.env.NODE_ENV === "production";
  // F4: refuse the SSRF test escape hatch in production (also enforced by
  // `createProductionPorts` and ignored per-integration in the engine).
  const loopbackRaw = process.env.PODS_ALLOW_LOOPBACK;
  if (isProd && loopbackRaw !== undefined && loopbackRaw !== null && String(loopbackRaw) !== "" && String(loopbackRaw) !== "0") {
    throw new Error("PODS_ALLOW_LOOPBACK must not be set when NODE_ENV=production (F4).");
  }
  const { createSupabaseLoader, createMemoryLoader } = await import("./loader.mjs");
  const { kvFromEnv } = await import("../lib/gateway/state/kv.mjs");
  const rawKv = await kvFromEnv(process.env).catch(() => new MemoryKvStore({}));
  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let loader;
  let supabase = null;
  if (url && serviceKey) {
    supabase = createClient(url, serviceKey, { auth: { persistSession: false } });
    // Attach usage to the shared KV before the loader subscribes, so stage
    // invalidations and usage invalidations share one store.
    const ports = createProductionPorts({ env: process.env, supabase, kv: rawKv });
    loader = createSupabaseLoader({ supabase, kv: ports.kv });
    return await startWithPorts(loader, ports);
  }
  if (isProd) {
    throw new Error("SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY are required when NODE_ENV=production.");
  }
  const ports = createProductionPorts({ env: process.env, supabase: null, kv: rawKv });
  loader = createMemoryLoader({ kv: ports.kv });
  return await startWithPorts(loader, ports);
}

/**
 * Starts the gateway with a loader + production ports (shared by `main()`).
 *
 * @param {object} loader - Stage/artifact loader.
 * @param {object} ports - Production ports from `createProductionPorts`.
 */
async function startWithPorts(loader, ports) {
  const kv = ports.kv;
  const gateway = createGatewayServer({ loader, ports });
  const port = Number(process.env.PORT ?? 4000);
  await gateway.start(port);
  console.log(`gateway listening on :${port} (pathRouting=${process.env.PODS_GATEWAY_PATH_ROUTING ?? "0"})`);

  const shutdown = async () => {
    try {
      ports.connectorHub?.close?.();
    } catch {
      // Best-effort.
    }
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
