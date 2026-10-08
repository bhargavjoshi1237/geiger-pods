/**
 * Agent tool gateway (S13 part E, MCP).
 *
 * The equivalent of "REST API as an AgentCore Gateway target": an opt-in per
 * stage (`stages.agent_tools = { enabled, allowOperations[], auth:
 * "passthrough" }`). Served as MCP **Streamable HTTP** (`POST /_mcp` with a
 * JSON-RPC 2.0 body; `Accept: application/json, text/event-stream`).
 *
 * - `tools/list`: one tool per allowed operation. Name = `operationName` or
 *   `METHOD_path` sanitized. Description from documentation parts. Input JSON
 *   Schema built from path/query/header params and the request body model.
 * - `tools/call`: builds an HTTP request and runs it through the normal
 *   pipeline in-process (`buildContext` + `runPipeline`), so authorization,
 *   keys, throttling, WAF and logs all apply. The caller's `Authorization` /
 *   `x-api-key` headers are forwarded. Results return as text/JSON content.
 *
 * Pure ES module except the injected pipeline (`ports`, `usage` override for
 * tests). No Next.js, Supabase or Node-only APIs.
 *
 * @module lib/gateway/distribution/mcp
 */

import { buildContext } from "../core/context.mjs";
import { runPipeline } from "../core/pipeline.mjs";

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * Sanitizes an operation name to an MCP tool name (`operationName` or
 * `METHOD_path` with non `[A-Za-z0-9_.-]` runs collapsed to `_`).
 *
 * @param {string} name
 * @returns {string}
 */
export function sanitizeToolName(name) {
  const cleaned = String(name ?? "").replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 128);
  const out = cleaned === "" ? "tool" : cleaned;
  if (!TOOL_NAME_PATTERN.test(out)) return "tool";
  return out;
}

function defaultToolName(operation) {
  if (operation.operationName && operation.operationName.trim() !== "") {
    return sanitizeToolName(operation.operationName.trim());
  }
  return sanitizeToolName(`${operation.method}_${operation.path}`);
}

/**
 * Lists SDK-style operations from a compiled artifact (REST + HTTP).
 *
 * @param {object} [artifact={}]
 * @returns {Array<{ method: string, path: string, operationName: string,
 *   apiKeyRequired: boolean, requestParameters: object, requestModels: object,
 *   authType: string }>}
 */
export function listArtifactOperations(artifact = {}) {
  const out = [];
  if (artifact.protocol === "HTTP") {
    for (const route of artifact.routes ?? []) {
      const key = String(route.routeKey ?? "");
      const space = key.indexOf(" ");
      if (space === -1) continue;
      out.push({
        method: key.slice(0, space).toUpperCase(),
        path: key.slice(space + 1),
        operationName: typeof route.operationName === "string" ? route.operationName : "",
        apiKeyRequired: Boolean(route.apiKeyRequired),
        requestParameters: { ...(route.requestParameters ?? {}) },
        requestModels: { ...(route.requestModels ?? {}) },
        authType: route.auth?.type ?? "NONE",
      });
    }
    return out;
  }
  for (const resource of artifact.resources ?? []) {
    for (const [method, entry] of Object.entries(resource.methods ?? {})) {
      out.push({
        method: String(method).toUpperCase(),
        path: String(resource.path ?? "/"),
        operationName: typeof entry?.operationName === "string" ? entry.operationName : "",
        apiKeyRequired: Boolean(entry?.apiKeyRequired),
        requestParameters: { ...(entry?.requestParameters ?? {}) },
        requestModels: { ...(entry?.requestModels ?? {}) },
        authType: entry?.auth?.type ?? "NONE",
      });
    }
  }
  return out;
}

/**
 * Builds the MCP input JSON Schema for one operation from its
 * path/query/header params plus the request body model.
 *
 * Shape: `{ type: "object", properties: { "path.<n>", "query.<n>" (bare
 * alias), "header.<n>", body }, required: [...] }`. Query params keep a bare
 * alias (`limit` for `query.limit`) for agent ergonomics; the namespaced
 * keys always work.
 *
 * @param {{ requestParameters?: object, requestModels?: object }} operation
 * @param {Record<string, object>} [models={}]
 * @returns {{ type: string, properties: object, required: Array<string> }}
 */
export function buildMcpInputSchema(operation = {}, models = {}) {
  const properties = {};
  const required = [];
  for (const [key, isRequired] of Object.entries(operation.requestParameters ?? {})) {
    const match = /^method\.request\.(querystring|header|path)\.(.+)$/.exec(key);
    if (!match) continue;
    const [, location, name] = match;
    const short = location === "querystring" ? "query" : location;
    const namespaced = `${short}.${name}`;
    properties[namespaced] = { type: "string", description: `${short} parameter ${name}` };
    if (location === "querystring" && !Object.hasOwn(properties, name)) {
      properties[name] = { type: "string", description: `query parameter ${name}` };
    }
    if (isRequired === true) {
      required.push(namespaced);
      if (location === "querystring" && !required.includes(name)) required.push(name);
    }
  }
  const modelName = Object.values(operation.requestModels ?? {})[0];
  if (typeof modelName === "string" && modelName !== "") {
    const schema = models?.[modelName]?.schema ?? models?.[modelName] ?? null;
    properties.body = schema && typeof schema === "object"
      ? { description: `Request body (${modelName})`, ...schema }
      : { type: "object", description: `Request body (${modelName})` };
    required.push("body");
  }
  return { type: "object", properties, required };
}

/**
 * Lists MCP tools for an artifact.
 *
 * @param {object} artifact - Compiled deployment artifact.
 * @param {{ allowOperations?: Array<string>|null, docsByLocation?: Map<string, object> }} [options={}]
 * @returns {Array<{ name: string, description: string, inputSchema: object,
 *   method: string, path: string }>}
 */
export function listMcpTools(artifact, { allowOperations = null, docsByLocation = new Map() } = {}) {
  const operations = listArtifactOperations(artifact);
  const allow = Array.isArray(allowOperations) && allowOperations.length > 0 ? new Set(allowOperations) : null;
  const models = artifact.models ?? {};
  const tools = [];
  for (const operation of operations) {
    const name = defaultToolName(operation);
    if (allow && !allow.has(name) && !allow.has(`${operation.method} ${operation.path}`)) continue;
    const docs = docsByLocation?.get?.(`${operation.method} ${operation.path}`)
      ?? docsByLocation?.get?.(`* ${operation.path}`)
      ?? null;
    tools.push({
      name,
      description: docs?.description ?? docs?.summary ?? `${operation.method} ${operation.path}`,
      inputSchema: buildMcpInputSchema(operation, models),
      method: operation.method,
      path: operation.path,
    });
  }
  return tools;
}

function mcpError(id, code, message, data = undefined) {
  return {
    jsonrpc: "2.0", id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function applyArgumentsToPath(template, args) {
  let path = String(template);
  for (const [key, value] of Object.entries(args ?? {})) {
    if (!key.startsWith("path.")) continue;
    const name = key.slice("path.".length);
    path = path
      .replace(`{${name}}`, encodeURIComponent(String(value)))
      .replace(`{${name}+}`, String(value).split("/").map(encodeURIComponent).join("/"));
  }
  return path;
}

/**
 * Runs one tool call through the normal gateway pipeline in-process.
 *
 * Builds a Web Request for the operation (path params substituted, query +
 * header params from `query.*`/`header.*` args, JSON body from `body`) and
 * runs `buildContext` + `runPipeline`, so authorizers, API keys, throttling,
 * WAF and logs apply exactly as for HTTP traffic. Caller `Authorization` /
 * `x-api-key` headers are forwarded; MCP `arguments` win on conflict.
 *
 * @param {{ artifact: object, tool: object, operation: object, args?: object,
 *   headers?: object, ports?: object, usage?: object }} input
 * @returns {Promise<Response>}
 */
export async function callToolViaPipeline({ artifact, tool, operation, args = {}, headers = {}, ports = {}, usage = null }) {
  const safeArgs = args && typeof args === "object" ? args : {};
  const resolvedPath = applyArgumentsToPath(operation.path, safeArgs);
  const url = new URL(`http://mcp.local${resolvedPath.startsWith("/") ? resolvedPath : `/${resolvedPath}`}`);
  for (const [key, value] of Object.entries(safeArgs)) {
    if (value === undefined || value === null) continue;
    if (key.startsWith("query.") || (!key.includes(".") && !key.startsWith("header.") && !key.startsWith("path."))) {
      const name = key.startsWith("query.") ? key.slice("query.".length) : key;
      if (key === "body" || key.startsWith("path.") || key.startsWith("header.")) continue;
      url.searchParams.append(name, String(value));
    }
  }
  const outgoing = new Headers();
  const forwarded = headers ?? {};
  const getHeader = (name) => {
    if (typeof forwarded.get === "function") return forwarded.get(name);
    const bag = forwarded ?? {};
    for (const key of Object.keys(bag)) {
      if (key.toLowerCase() === String(name).toLowerCase()) return bag[key];
    }
    return null;
  };
  for (const name of ["authorization", "x-api-key"]) {
    const value = getHeader(name);
    if (value !== null && value !== undefined && value !== "") outgoing.set(name, String(value));
  }
  for (const [key, value] of Object.entries(safeArgs)) {
    if (!key.startsWith("header.") || value === undefined || value === null) continue;
    outgoing.set(key.slice("header.".length), String(value));
  }
  const hasBody = Object.keys(operation.requestModels ?? {}).length > 0;
  const body = hasBody && safeArgs.body !== undefined && safeArgs.body !== null
    ? (typeof safeArgs.body === "string" ? safeArgs.body : JSON.stringify(safeArgs.body))
    : null;
  if (body !== null && !outgoing.has("content-type")) outgoing.set("content-type", "application/json");
  const request = new Request(url.toString(), {
    method: operation.method,
    headers: outgoing,
    ...(body !== null && operation.method !== "GET" && operation.method !== "HEAD" ? { body, duplex: "half" } : {}),
  });
  const fullPorts = { ...(ports ?? {}) };
  if (fullPorts.clock === undefined) fullPorts.clock = { now: () => Date.now() };
  const ctx = buildContext(request, { ...(artifact ?? {}), stage: artifact.stage ?? "prod" }, fullPorts);
  if (usage !== null && usage !== undefined) ctx.usage = { ...(ctx.usage ?? {}), ...usage };
  else if (!ctx.usage) ctx.usage = {};
  void tool;
  return runPipeline(ctx);
}

/**
 * Handles one MCP Streamable-HTTP JSON-RPC request (`tools/list`,
 * `tools/call`; `initialize`/`ping` for handshake).
 *
 * @param {{ artifact: object, stageConfig?: object, docsByLocation?: Map<string, object>,
 *   body: object, headers?: object, ports?: object, usage?: object }} input
 * @returns {Promise<object>} JSON-RPC response.
 */
export async function handleMcpRequest({ artifact, stageConfig = {}, docsByLocation = new Map(), body, headers = {}, ports = {}, usage = null }) {
  const id = body?.id ?? null;
  if (!body || typeof body !== "object" || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return mcpError(id, -32600, "Invalid Request: expected JSON-RPC 2.0 { method }.");
  }
  if (stageConfig?.enabled !== true) {
    return mcpError(id, -32000, "Agent tools are not enabled for this stage.");
  }
  if (body.method === "initialize") {
    return {
      jsonrpc: "2.0", id,
      result: { protocolVersion: "2025-06-18", serverInfo: { name: "pods-agent-tools", version: "1.0.0" }, capabilities: { tools: {} } },
    };
  }
  if (body.method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (body.method === "tools/list") {
    const tools = listMcpTools(artifact, {
      allowOperations: stageConfig.allowOperations ?? null, docsByLocation,
    });
    return {
      jsonrpc: "2.0", id,
      result: {
        tools: tools.map((entry) => ({
          name: entry.name, description: entry.description, inputSchema: entry.inputSchema,
        })),
      },
    };
  }
  if (body.method === "tools/call") {
    const name = body.params?.name;
    const args = body.params?.arguments ?? {};
    if (typeof name !== "string" || name === "") return mcpError(id, -32602, "Invalid params: $.name is required.");
    if (args !== null && typeof args !== "object") return mcpError(id, -32602, "Invalid params: $.arguments must be an object.");
    const tools = listMcpTools(artifact, {
      allowOperations: stageConfig.allowOperations ?? null, docsByLocation,
    });
    const tool = tools.find((entry) => entry.name === name);
    if (!tool) return mcpError(id, -32602, `Unknown tool "${String(name).slice(0, 128)}".`);
    const operations = listArtifactOperations(artifact);
    const operation = operations.find((entry) => defaultToolName(entry) === name) ?? null;
    if (!operation) return mcpError(id, -32602, `Unknown tool "${String(name).slice(0, 128)}".`);
    let response;
    try {
      response = await callToolViaPipeline({ artifact, tool, operation, args, headers, ports, usage });
    } catch (error) {
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Pipeline error: ${error?.message ?? error}` }], isError: true } };
    }
    const text = await response.text().catch(() => "");
    const contentType = response.headers.get("content-type") ?? "application/json";
    const block = contentType.includes("json")
      ? { type: "text", text }
      : { type: "text", text };
    if (response.status >= 400) {
      return {
        jsonrpc: "2.0", id,
        result: {
          content: [{ ...block, text: `HTTP ${response.status}: ${text.slice(0, 4000)}` }],
          isError: true, status: response.status,
        },
      };
    }
    return { jsonrpc: "2.0", id, result: { content: [block], isError: false, status: response.status } };
  }
  return mcpError(id, -32601, `Method not found: ${body.method}.`);
}
