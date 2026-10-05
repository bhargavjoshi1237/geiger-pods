// Management API HTTP client for the CLI (S14 §3). Pure fetch wrapper so
// tests inject a stub; profiles come from ~/.config/pods/config.json with
// PODS_TOKEN / PODS_PROJECT / PODS_BASE_URL env overrides.
//
// @module cli/client
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Loads profiles from the config file. Missing file → `{}`.
 *
 * @param {string} [configPath]
 * @returns {Promise<Record<string, { baseUrl?: string, projectId?: string, token?: string }>>}
 */
export async function loadProfiles(configPath = join(homedir(), ".config", "pods", "config.json")) {
  try {
    return JSON.parse(await readFile(configPath, "utf8")).profiles ?? {};
  } catch {
    return {};
  }
}

/**
 * Resolves connection settings: flags > env > profile.
 */
export function resolveConnection({ profile = "default", baseUrl, projectId, token, profiles = {} } = {}) {
  const stored = profiles[profile] ?? {};
  const resolved = {
    baseUrl: baseUrl ?? process.env.PODS_BASE_URL ?? stored.baseUrl ?? "http://localhost:3000",
    projectId: projectId ?? process.env.PODS_PROJECT ?? stored.projectId ?? null,
    token: token ?? process.env.PODS_TOKEN ?? stored.token ?? null,
  };
  return resolved;
}

/**
 * Creates a client bound to a base URL, project and token.
 */
export function createClient({ baseUrl, projectId, token, fetchImpl = globalThis.fetch } = {}) {
  if (!projectId) throw new ApiError(2, "usage", "Select a project: --project, PODS_PROJECT, or a profile.");

  async function request(method, path, { body, query, idempotencyKey } = {}) {
    const url = new URL(`/api/v1/projects/${projectId}${path}`, baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const response = await fetchImpl(url.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ApiError(response.status, payload?.error?.code ?? "request_failed", payload?.error?.message ?? `Request failed (${response.status}).`);
    }
    return payload;
  }

  return {
    get: (path, opts) => request("GET", path, opts),
    post: (path, opts) => request("POST", path, opts),
    put: (path, opts) => request("PUT", path, opts),
    patch: (path, opts) => request("PATCH", path, opts),
    del: (path, opts) => request("DELETE", path, opts),
  };
}
