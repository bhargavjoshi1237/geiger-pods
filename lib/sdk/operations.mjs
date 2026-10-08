/**
 * Shared operation enumeration for SDK generators (S13 part C).
 *
 * Reads the compiled artifact (REST `resources[].methods` and HTTP `routes`)
 * so every language renders the same operation set as the OpenAPI export.
 *
 * @module lib/sdk/operations
 */

/**
 * Lists SDK operations from a compiled artifact.
 *
 * @param {object} [artifact={}]
 * @returns {Array<{ method: string, path: string, operationName: string,
 *   apiKeyRequired: boolean, requestParameters: object, requestModels: object,
 *   authType: string }>}
 */
export function listSdkOperations(artifact = {}) {
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
 * Derives a JS-safe method name: `operationName` or `METHOD_path`.
 *
 * @param {{ method: string, path: string, operationName: string }} operation
 * @returns {string}
 */
export function sdkMethodName(operation) {
  const raw = operation.operationName?.trim() ? operation.operationName.trim() : `${operation.method}_${operation.path}`;
  const cleaned = raw.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[0-9]+/, "");
  const name = cleaned === "" ? "call" : cleaned;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : `op_${name}`;
}

/**
 * Splits `method.request.*` params into path/query/header groups.
 *
 * @param {object} [requestParameters={}]
 * @returns {{ path: Array<string>, query: Array<{ name: string, required: boolean }>,
 *   header: Array<{ name: string, required: boolean }> }}
 */
export function groupSdkParams(requestParameters = {}) {
  const path = [];
  const query = [];
  const header = [];
  for (const [key, required] of Object.entries(requestParameters ?? {})) {
    const match = /^method\.request\.(querystring|header|path)\.(.+)$/.exec(key);
    if (!match) continue;
    const [, location, name] = match;
    if (location === "path") path.push(name);
    else if (location === "querystring") query.push({ name, required: required === true });
    else header.push({ name, required: required === true });
  }
  return { path, query, header };
}
