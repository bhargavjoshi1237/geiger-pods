/**
 * Backend credential injection (S04 §5, Pods vault extension, P0).
 *
 * `backend_auth = { type, secretRef, headerName?, awsService?, awsRegion? }`:
 * `header` / `bearer` / `basic_auth` / `query` / `oauth_client_credentials` /
 * `aws_sigv4` / `client_certificate`. Secrets resolve through `ports.secrets`
 * at invoke time and are cached in-process for ≤ 60 s. They never enter
 * `$context`, logs, traces or errors — values are masked as `****`.
 * Client-supplied headers with the same name are overwritten, never merged.
 *
 * @module lib/gateway/core/integrations/backend-auth
 */

import { signRequest } from "../auth/sigv4.mjs";

/** In-process secret cache TTL: 60 s (spec §5). */
export const SECRET_CACHE_TTL_MS = 60_000;

/** Value placeholder used anywhere a secret would otherwise appear. */
export const MASKED = "****";

/** @type {Map<string, { value: unknown, expiresAt: number }>} */
const secretCache = new Map();

/** Clears the in-process secret cache (tests). */
export function clearSecretCache() {
  secretCache.clear();
}

/**
 * Resolves a secret ref with the 60 s in-process cache.
 *
 * @param {string} ref - `secret:<id>` or `secret:<id>@<version>`.
 * @param {{ resolve(ref: string): Promise<unknown> }} secrets - `ports.secrets`.
 * @returns {Promise<{ kind: string, value: Record<string, unknown> }>}
 */
export async function resolveCachedSecret(ref, secrets) {
  const cached = secretCache.get(ref);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const resolved = await secrets.resolve(ref);
  // The vault returns `{ kind, value, version }`; accept a bare value too.
  const normalized = resolved && typeof resolved === "object" && "value" in resolved
    ? resolved
    : { kind: "generic", value: resolved };
  secretCache.set(ref, { value: normalized, expiresAt: Date.now() + SECRET_CACHE_TTL_MS });
  return normalized;
}

/** Forgets one cached ref (used after an OAuth 401 to force a refresh). */
export function forgetCachedSecret(ref) {
  secretCache.delete(ref);
}

/**
 * Applies backend auth to an outbound request. Mutates and returns
 * `{ headers: Headers, url, tlsMaterial }`. Never throws secret values:
 * failures carry `backend_auth_failed` with the value masked.
 *
 * @param {{ headers?: Headers, url?: string | URL }} outbound
 * @param {{ type: string, secretRef?: string | null, headerName?: string | null, awsService?: string | null, awsRegion?: string | null, tokenUrl?: string | null }} backendAuth
 * @param {object} ports - (`secrets`, `fetch`, `kv` for OAuth caching).
 * @param {{ method?: string, body?: unknown }} [request={}] - For `aws_sigv4` signing.
 * @returns {Promise<{ headers: Headers, url: string, tlsMaterial?: { certPem: string, keyPem: string } | null, oauth?: { refreshOnce(): Promise<void> } | null }}>}
 */
export async function applyBackendAuth(outbound, backendAuth, ports, request = {}) {
  const headers = outbound.headers instanceof Headers ? new Headers(outbound.headers) : new Headers(outbound.headers ?? {});
  let url = outbound.url?.toString?.() ?? String(outbound.url ?? "");
  if (!backendAuth || !backendAuth.type) return { headers, url, tlsMaterial: null, oauth: null };
  const { type, secretRef, headerName } = backendAuth;

  const fail = (reason) => {
    throw Object.assign(new Error(`Backend auth failed (${reason}); secret ${MASKED}.`), {
      code: "backend_auth_failed",
      reason,
    });
  };

  if (type === "header" || type === "bearer" || type === "basic_auth" || type === "query") {
    if (!secretRef) fail("missing-secret-ref");
    let secret;
    try {
      secret = await resolveCachedSecret(secretRef, ports.secrets);
    } catch {
      fail("unresolvable-secret");
    }
    const value = secret.value ?? {};
    if (type === "header") {
      if (!headerName) fail("missing-header-name");
      headers.set(headerName, String(value.value ?? value.token ?? ""));
    } else if (type === "bearer") {
      headers.set("authorization", `Bearer ${value.token ?? value.value ?? ""}`);
    } else if (type === "basic_auth") {
      const pair = `${value.username ?? ""}:${value.password ?? ""}`;
      headers.set("authorization", `Basic ${Buffer.from(pair, "utf8").toString("base64")}`);
    } else {
      if (!headerName) fail("missing-header-name");
      let next;
      try {
        next = new URL(url);
      } catch {
        // Never leak the raw URL error (it can echo the secret-bearing URL):
        // surface the masked backend-auth failure instead.
        fail("invalid-url");
      }
      next.searchParams.set(headerName, String(value.value ?? value.token ?? ""));
      url = next.toString();
    }
    return { headers, url, tlsMaterial: null, oauth: null };
  }

  if (type === "oauth_client_credentials") {
    if (!secretRef) fail("missing-secret-ref");
    let secret;
    try {
      secret = await resolveCachedSecret(secretRef, ports.secrets);
    } catch {
      fail("unresolvable-secret");
    }
    const conf = secret.value ?? {};
    const token = await getOAuthToken(conf, ports, { forceRefresh: false });
    headers.set("authorization", `Bearer ${token}`);
    return {
      headers,
      url,
      tlsMaterial: null,
      oauth: {
        async refreshOnce() {
          const fresh = await getOAuthToken(conf, ports, { forceRefresh: true });
          headers.set("authorization", `Bearer ${fresh}`);
        },
      },
    };
  }

  if (type === "aws_sigv4") {
    if (!secretRef) fail("missing-secret-ref");
    let secret;
    try {
      secret = await resolveCachedSecret(secretRef, ports.secrets);
    } catch {
      fail("unresolvable-secret");
    }
    const creds = secret.value ?? {};
    const service = backendAuth.awsService ?? "execute-api";
    const region = backendAuth.awsRegion ?? "us-east-1";
    const signed = await signRequest({
      method: request.method ?? "GET",
      url,
      headers: Object.fromEntries(headers.entries()),
      body: request.body ?? "",
      service,
      region,
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    });
    return { headers: new Headers(signed.headers), url: signed.url, tlsMaterial: null, oauth: null };
  }

  if (type === "client_certificate") {
    if (!secretRef) fail("missing-secret-ref");
    let secret;
    try {
      secret = await resolveCachedSecret(secretRef, ports.secrets);
    } catch {
      fail("unresolvable-secret");
    }
    const material = secret.value ?? {};
    return {
      headers,
      url,
      tlsMaterial: {
        certPem: String(material.certificatePem ?? ""),
        keyPem: String(material.privateKeyPem ?? material.pem ?? ""),
      },
      oauth: null,
    };
  }

  fail("unknown-type");
  return { headers, url, tlsMaterial: null, oauth: null };
}

/**
 * Fetches (and KV-caches) an OAuth client-credentials token until
 * `expires_in - 60s`. A 401 from the backend triggers one refresh + retry
 * via the `oauth.refreshOnce` hook above.
 *
 * @param {{ tokenUrl?: string, clientId?: string, clientSecret?: string, scope?: string, audience?: string }} conf
 * @param {object} ports - (`fetch`, `kv`).
 * @param {{ forceRefresh?: boolean }} [opts={}]
 * @returns {Promise<string>} Access token (never logged by this module).
 */
export async function getOAuthToken(conf, ports, opts = {}) {
  const tokenUrl = conf.tokenUrl ?? conf.token_url;
  if (!tokenUrl) throw new Error("Backend auth failed (missing-token-url).");
  const cacheKey = `pods:oauth:${tokenUrl}:${conf.clientId ?? ""}`;
  if (!opts.forceRefresh && ports.kv) {
    const cached = await ports.kv.get(cacheKey).catch(() => null);
    if (cached) return cached;
  }
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: String(conf.clientId ?? ""),
    client_secret: String(conf.clientSecret ?? conf.client_secret ?? ""),
  });
  if (conf.scope) params.set("scope", String(conf.scope));
  if (conf.audience) params.set("audience", String(conf.audience));
  const fetchFn = ports.fetch ?? globalThis.fetch;
  const response = await fetchFn(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    // Never follow redirects: a 307/308 would re-send the client_secret to
    // the redirect target. A 3xx here fails closed below via !response.ok.
    redirect: "manual",
  });
  if (!response.ok) {
    throw Object.assign(new Error(`Backend auth failed (token-endpoint-${response.status}).`), {
      code: "backend_auth_failed",
    });
  }
  const payload = await response.json();
  const token = payload.access_token;
  if (!token) throw Object.assign(new Error("Backend auth failed (no-access-token)."), { code: "backend_auth_failed" });
  const ttlMs = Math.max(0, Number(payload.expires_in ?? 3600) * 1000 - 60_000);
  if (ports.kv && ttlMs > 0) await ports.kv.set(cacheKey, String(token), { ttlMs }).catch(() => {});
  return String(token);
}
