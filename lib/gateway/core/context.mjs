/**
 * `$context` builder and variable resolver.
 *
 * One builder produces the `$context` object used by mapping (S06),
 * templates (S06), access-log formats (S10), authorizer inputs (S07) and
 * gateway responses. Names follow AWS so imported AWS configs work
 * unchanged. `accountId` is the Geiger project id.
 *
 * Later specs fill in the fields they own (authorizer, integration,
 * WAF, canary, connection, ...); S01 sets request identity, placement
 * and caller basics, and defaults everything else to `""`.
 *
 * @module lib/gateway/core/context
 */

import { newExtendedRequestId, newRequestId } from "../ids.mjs";
import { ensureTrace } from "./observe/index.mjs";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Formats a timestamp as CLF `dd/MMM/yyyy:HH:mm:ss +0000` in UTC.
 *
 * @param {number | Date} when - Epoch ms or Date.
 * @returns {string}
 */
export function formatClfTime(when) {
  const d = when instanceof Date ? when : new Date(when);
  return (
    `${pad2(d.getUTCDate())}/${MONTHS[d.getUTCMonth()]}/` +
    `${d.getUTCFullYear()}:${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:` +
    `${pad2(d.getUTCSeconds())} +0000`
  );
}

/**
 * Builds the pipeline context for one request: identity, placement and
 * an AWS-shaped `$context` object with S01-known fields filled in.
 *
 * The artifact is the S05 compiled deployment artifact; S01 reads only
 * the placement fields it defines (`protocol`, `apiId`, `stage`,
 * `deploymentId`, `projectId`, `domainName`, `stageVariables`) and
 * tolerates their absence (stub artifacts in tests).
 *
 * @param {Request} request - Incoming Web request.
 * @param {object} [artifact={}] - Compiled deployment artifact (read-only).
 * @param {object} [ports={}] - Injected ports (uses `clock` for start time).
 * @param {{ requestId?: string }} [opts={}] - Test overrides.
 * @returns {{ request: Request, artifact: object, ports: object, requestId: string, startTime: number, context: Record<string, any>, stageVariables: Record<string, string> }}
 */
export function buildContext(request, artifact = {}, ports = {}, opts = {}) {
  const now = ports?.clock?.now?.() ?? Date.now();
  const requestId = opts.requestId ?? newRequestId();
  const url = new URL(request.url);
  const headers = request.headers;
  const forwarded = headers.get("x-forwarded-for") ?? "";
  const sourceIp = forwarded.split(",")[0]?.trim() ?? "";
  const domainName = artifact.domainName ?? headers.get("host") ?? "";
  const message = "";

  const context = {
    requestId,
    extendedRequestId: newExtendedRequestId(now),
    requestTime: formatClfTime(now),
    requestTimeEpoch: now,
    accountId: artifact.projectId ?? artifact.accountId ?? "",
    apiId: artifact.apiId ?? "",
    stage: artifact.stage ?? "",
    deploymentId: artifact.deploymentId ?? "",
    domainName,
    domainPrefix: domainName.split(".")[0] ?? "",
    httpMethod: request.method,
    path: url.pathname,
    resourcePath: "",
    resourceId: "",
    routeKey: "",
    protocol: artifact.protocol ?? "",
    identity: {
      sourceIp,
      userAgent: headers.get("user-agent") ?? "",
      apiKey: "",
      apiKeyId: "",
      caller: "",
      user: "",
      userArn: "",
      accessKey: "",
      clientCert: {
        clientCertPem: "",
        subjectDN: "",
        issuerDN: "",
        serialNumber: "",
        validity: { notBefore: "", notAfter: "" },
      },
    },
    authorizer: {
      principalId: "",
      claims: {},
      scopes: "",
      error: "",
      latency: "",
      status: "",
      integrationLatency: "",
      requestId: "",
    },
    authenticate: { error: "", latency: "", status: "" },
    integration: {
      status: "",
      latency: "",
      error: "",
      requestId: "",
      integrationStatus: "",
    },
    integrationLatency: "",
    integrationStatus: "",
    responseLatency: "",
    responseLength: "",
    status: "",
    error: { message, messageString: JSON.stringify(message), responseType: "", validationErrorString: "" },
    waf: { error: "", latency: "", status: "" },
    wafResponseCode: "",
    webaclArn: "",
    traceId: "",
    isCanaryRequest: "",
    connectionId: "",
    connectedAt: "",
    eventType: "",
    messageId: "",
    messageDirection: "",
    customDomain: { basePathMatched: "", routingRuleIdMatched: "" },
  };

  const ctx = {
    request,
    artifact,
    ports,
    requestId,
    startTime: now,
    context,
    stageVariables: { ...(artifact.stageVariables ?? {}) },
  };
  // S10: every phase calls ctx.trace(level, message); it always exists and is
  // no-op-safe (backed by an execution-log collector buffer).
  ensureTrace(ctx);
  return ctx;
}

/**
 * Creates the root object variable paths resolve against.
 *
 * @param {{ context?: object, stageVariables?: object }} ctx
 * @returns {Record<string, unknown>}
 */
function resolveRoot(ctx) {
  return {
    context: ctx?.context ?? {},
    stageVariables: ctx?.stageVariables ?? {},
  };
}

function getPath(root, segments) {
  let cur = root;
  for (const seg of segments) {
    if (seg === "__proto__" || seg === "constructor" || seg === "prototype") return undefined;
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Resolves a `$context` variable path to a string.
 * Unknown names resolve to `""` (flagged by config validation, not at
 * runtime). `error.messageString` is the JSON-quoted `error.message`.
 * Accepts paths with or without a leading `$` (`context.…`,
 * `$context.…`, `stageVariables.…`, `$stageVariables.…`).
 *
 * @param {{ context?: object, stageVariables?: object }} ctx - Pipeline context.
 * @param {string} name - Variable path, e.g. `"context.identity.sourceIp"`.
 * @returns {string}
 */
export function resolveVariable(ctx, name) {
  if (typeof name !== "string") return "";
  let path = name.trim().replace(/^\$/, "");
  if (!path) return "";
  // `$stageVariables.<name>` is shorthand for the stage-variables map.
  if (path === "stageVariables") return "";
  const segments = path.split(".");
  // Lazily quote error.message so late-set errors stay consistent.
  if (
    segments.length >= 3 &&
    segments[0] === "context" &&
    segments[segments.length - 1] === "messageString" &&
    segments[segments.length - 2] === "error"
  ) {
    const message = getPath(resolveRoot(ctx), [...segments.slice(0, -1), "message"]);
    return JSON.stringify(typeof message === "string" ? message : "");
  }
  const value = getPath(resolveRoot(ctx), segments);
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}
