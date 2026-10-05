/**
 * Gateway runtime loader (S05 §5).
 *
 * `resolve(host, path) → { api, stage, deployment, basePathStripped }`.
 * Order: custom domain (S11, not yet — falls through) → default host pattern
 * → path-based. Store: Postgres via `@supabase/supabase-js` with
 * `SUPABASE_SERVICE_ROLE_KEY`, read-only queries on `apis(public_id)`,
 * `stages`, `deployments`. Caches: artifacts keyed by deployment id (LRU 500,
 * immutable, never expire); stage pointers expire after 5 s and are
 * invalidated immediately on `pods:stage-changed` (KV pub/sub). Negative
 * cache for unknown hosts: 5 s. On a store outage, keep serving cached
 * artifacts ("stale-if-error"); an unknown API during an outage → 503.
 *
 * The Supabase-backed loader is written but can only be exercised with a
 * real DB; tests use a fake client object or the in-memory loader.
 *
 * @module gateway/loader
 */

export const STAGE_TTL_MS = 5000;
export const NEGATIVE_TTL_MS = 5000;
export const ARTIFACT_CACHE_SIZE = 500;
export const STAGE_CHANGED_CHANNEL = "pods:stage-changed";

/**
 * Normalizes a gateway domain for host matching (lowercase, no port).
 *
 * @param {string} host
 * @returns {string}
 */
export function normalizeHost(host) {
  return String(host ?? "").split(",")[0].trim().split(":")[0].toLowerCase();
}

/**
 * Creates an in-memory loader for tests: fixture artifacts plus stage
 * pointers, no Supabase. `stages` maps `${apiPublicId}:${stage}` →
 * `{ artifact, stageVariables?, deploymentId? }`.
 *
 * @param {{ artifacts?: Map<string, object>|Record<string, object>, stages?: Map<string, object>|Record<string, object>,
 *   domain?: string|null, pathRouting?: boolean, kv?: object|null }} [options={}]
 */
export function createMemoryLoader(options = {}) {
  const artifacts = options.artifacts instanceof Map
    ? options.artifacts
    : new Map(Object.entries(options.artifacts ?? {}));
  const stages = options.stages instanceof Map
    ? options.stages
    : new Map(Object.entries(options.stages ?? {}));
  const domain = options.domain ?? process.env.PODS_GATEWAY_DOMAIN ?? null;
  const pathRouting = options.pathRouting ?? process.env.PODS_GATEWAY_PATH_ROUTING === "1";
  const kv = options.kv ?? null;

  if (kv && typeof kv.subscribe === "function") {
    try {
      const maybe = kv.subscribe(STAGE_CHANGED_CHANNEL, (message) => {
        try {
          const event = JSON.parse(String(message));
          if (event && event.apiPublicId && event.stage) {
            stages.delete(`${event.apiPublicId}:${event.stage}`);
          }
        } catch {
          // Ignore malformed invalidations; TTL still applies.
        }
      });
      if (maybe && typeof maybe.catch === "function") maybe.catch(() => {});
    } catch {
      // Best-effort only.
    }
  }

  /**
   * Resolves a host + path to an API + stage + artifact.
   *
   * @param {string} host
   * @param {string} path - Full request path (with query stripped).
   * @returns {Promise<{ apiPublicId: string, stage: string, artifact: object, stageVariables: object, basePathStripped: string, deploymentId: string|null }>}
   */
  async function resolve(host, path) {
    const cleanHost = normalizeHost(host);
    const cleanPath = String(path ?? "/").split("?")[0] || "/";
    // Path-based: /{apiPublicId}/{stage}/{rest}
    if (pathRouting || !domain || !cleanHost.endsWith(`.${String(domain).toLowerCase()}`)) {
      const segments = cleanPath.split("/").filter(Boolean);
      const apiPublicId = segments[0] ?? "";
      if (!apiPublicId) {
        const error = new Error("Not Found");
        error.status = 404;
        error.type = "RESOURCE_NOT_FOUND";
        throw error;
      }
      const remainder = `/${segments.slice(1).join("/")}` || "/";
      return resolveForApi(apiPublicId, remainder);
    }
    // Host-based: {apiPublicId}.{domain}/{stage}/{rest}
    const suffix = `.${String(domain).toLowerCase()}`;
    const apiPublicId = cleanHost.slice(0, -suffix.length);
    if (!apiPublicId || apiPublicId.includes(".")) {
      const error = new Error("Forbidden");
      error.status = 403;
      error.type = "ACCESS_DENIED";
      throw error;
    }
    return resolveForApi(apiPublicId, cleanPath);
  }

  /**
   * @param {string} apiPublicId
   * @param {string} remainder - Path after the host/api prefix.
   */
  async function resolveForApi(apiPublicId, remainder) {
    const segments = remainder.split("/").filter(Boolean);
    const first = segments[0] ?? "";
    // Exact stage pointer wins; otherwise $default serves without a prefix.
    if (first && stages.has(`${apiPublicId}:${first}`)) {
      const entry = stages.get(`${apiPublicId}:${first}`);
      const artifact = entry.artifact ?? entry;
      const stripped = `/${segments.slice(1).join("/")}` || "/";
      return {
        apiPublicId,
        stage: first,
        artifact: withStage(artifact, first, entry.stageVariables ?? artifact.stageVariables),
        stageVariables: entry.stageVariables ?? artifact.stageVariables ?? {},
        basePathStripped: stripped,
        deploymentId: entry.deploymentId ?? artifact.deploymentId ?? null,
        // S09: canary + stage cache travel alongside the base artifact.
        canary: entry.canary ?? artifact.canary ?? null,
        canaryArtifact: entry.canaryArtifact ?? artifact.canaryArtifact ?? null,
        stageCache: entry.stageCache ?? artifact.stageCache ?? null,
      };
    }
    if (stages.has(`${apiPublicId}:$default`)) {
      const entry = stages.get(`${apiPublicId}:$default`);
      const artifact = entry.artifact ?? entry;
      return {
        apiPublicId,
        stage: "$default",
        artifact: withStage(artifact, "$default", entry.stageVariables ?? artifact.stageVariables),
        stageVariables: entry.stageVariables ?? artifact.stageVariables ?? {},
        basePathStripped: remainder || "/",
        deploymentId: entry.deploymentId ?? artifact.deploymentId ?? null,
        canary: entry.canary ?? artifact.canary ?? null,
        canaryArtifact: entry.canaryArtifact ?? artifact.canaryArtifact ?? null,
        stageCache: entry.stageCache ?? artifact.stageCache ?? null,
      };
    }
    // No stage matched: REST → 403 Forbidden, HTTP → 404 Not Found.
    // The protocol is known only from a cached artifact; probe any stage.
    const anyKey = [...stages.keys()].find((key) => key.startsWith(`${apiPublicId}:`));
    const protocol = anyKey ? stages.get(anyKey)?.artifact?.protocol ?? stages.get(anyKey)?.protocol ?? "REST" : "REST";
    const error = new Error(protocol === "HTTP" ? "Not Found" : "Forbidden");
    error.status = protocol === "HTTP" ? 404 : 403;
    error.type = protocol === "HTTP" ? "RESOURCE_NOT_FOUND" : "MISSING_AUTHENTICATION_TOKEN";
    throw error;
  }

  function withStage(artifact, stage, stageVariables) {
    return { ...artifact, stage, stageVariables: { ...(stageVariables ?? {}) } };
  }

  return {
    resolve,
    /** Test hook: point a stage at a new artifact. */
    setStage(apiPublicId, stage, entry) {
      stages.set(`${apiPublicId}:${stage}`, entry);
    },
    /** Test hook: remove a stage pointer. */
    deleteStage(apiPublicId, stage) {
      stages.delete(`${apiPublicId}:${stage}`);
    },
  };
}

/**
 * Creates the Supabase-backed loader (service role, read-only).
 *
 * @param {{ supabase: object, kv?: object|null, domain?: string|null, pathRouting?: boolean,
 *   now?: () => number }} options
 */
export function createSupabaseLoader({ supabase, kv = null, domain = null, pathRouting = false, now = () => Date.now() } = {}) {
  if (!supabase) throw new TypeError("createSupabaseLoader requires a supabase client.");
  const gatewayDomain = domain ?? process.env.PODS_GATEWAY_DOMAIN ?? null;
  const usePathRouting = pathRouting || process.env.PODS_GATEWAY_PATH_ROUTING === "1";

  /** deploymentId → artifact (LRU, immutable, never expires). */
  const artifacts = new Map();
  /** `${apiPublicId}:${stage}` → { deploymentId, variables, expiresAt }. */
  const stagePointers = new Map();
  /** host/path → { expiresAt, status, type }. */
  const negative = new Map();

  function touchLru(key) {
    const value = artifacts.get(key);
    if (value === undefined) return;
    artifacts.delete(key);
    artifacts.set(key, value);
  }

  function putArtifact(id, artifact) {
    artifacts.delete(id);
    artifacts.set(id, artifact);
    while (artifacts.size > ARTIFACT_CACHE_SIZE) {
      const oldest = artifacts.keys().next().value;
      artifacts.delete(oldest);
    }
  }

  if (kv && typeof kv.subscribe === "function") {
    try {
      const maybe = kv.subscribe(STAGE_CHANGED_CHANNEL, (message) => {
        try {
          const event = JSON.parse(String(message));
          if (event && event.apiPublicId && event.stage) {
            stagePointers.delete(`${event.apiPublicId}:${event.stage}`);
          }
        } catch {
          // Ignore; TTL still applies.
        }
      });
      if (maybe && typeof maybe.catch === "function") maybe.catch(() => {});
    } catch {
      // Best-effort.
    }
  }

  async function getApiByPublicId(apiPublicId) {
    const { data, error } = await supabase.schema("pods").from("apis")
      .select("id, project_id, public_id, protocol")
      .eq("public_id", apiPublicId)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function getStage(apiId, name) {
    const { data, error } = await supabase.schema("pods").from("stages")
      .select("id, api_id, name, deployment_id, variables, canary, method_settings, cache_cluster_enabled, cache_cluster_size, cache_default_ttl, cache_data_encrypted, require_authorization_for_cache_control, unauthorized_cache_control_header_strategy")
      .eq("api_id", apiId)
      .eq("name", name)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  /**
   * S09: stage cache snapshot from a stage row (mutable settings travel
   * separately from the immutable artifact).
   *
   * @param {object|null} stage
   * @returns {object|null}
   */
  function stageCacheFromRow(stage) {
    if (!stage || !stage.cache_cluster_enabled) return null;
    return {
      enabled: true,
      size: stage.cache_cluster_size ?? null,
      defaultTtl: stage.cache_default_ttl ?? 300,
      encrypted: stage.cache_data_encrypted ?? false,
      requireAuth: stage.require_authorization_for_cache_control ?? true,
      strategy: stage.unauthorized_cache_control_header_strategy ?? "SUCCEED_WITH_RESPONSE_HEADER",
      methodSettings: stage.method_settings ?? {},
    };
  }

  async function getDeployment(id) {
    if (artifacts.has(id)) {
      touchLru(id);
      return artifacts.get(id);
    }
    const { data, error } = await supabase.schema("pods").from("deployments")
      .select("id, artifact")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    putArtifact(id, data.artifact);
    return data.artifact;
  }

  /**
   * @param {string} host
   * @param {string} path
   */
  async function resolve(host, path) {
    const cleanHost = normalizeHost(host);
    const cleanPath = String(path ?? "/").split("?")[0] || "/";
    const negativeKey = `${cleanHost}${cleanPath}`;
    const cachedNegative = negative.get(negativeKey);
    if (cachedNegative && cachedNegative.expiresAt > now()) {
      const error = new Error(cachedNegative.message);
      error.status = cachedNegative.status;
      error.type = cachedNegative.type;
      throw error;
    }
    try {
      if (usePathRouting || !gatewayDomain || !cleanHost.endsWith(`.${String(gatewayDomain).toLowerCase()}`)) {
        const segments = cleanPath.split("/").filter(Boolean);
        const apiPublicId = segments[0] ?? "";
        if (!apiPublicId) throw Object.assign(new Error("Not Found"), { status: 404, type: "RESOURCE_NOT_FOUND" });
        return await resolveForApi(apiPublicId, `/${segments.slice(1).join("/")}` || "/");
      }
      const suffix = `.${String(gatewayDomain).toLowerCase()}`;
      const apiPublicId = cleanHost.slice(0, -suffix.length);
      if (!apiPublicId || apiPublicId.includes(".")) {
        throw Object.assign(new Error("Forbidden"), { status: 403, type: "ACCESS_DENIED" });
      }
      return await resolveForApi(apiPublicId, cleanPath);
    } catch (error) {
      if (error && (error.code === "PGRST116" || /fetch failed|network|timeout/i.test(error.message ?? ""))) {
        // Store outage: serve cached artifacts when possible; unknown → 503.
        throw Object.assign(new Error("Service Unavailable"), { status: 503, type: "DEFAULT_5XX" });
      }
      if (error && typeof error.status === "number" && (error.status === 403 || error.status === 404)) {
        negative.set(negativeKey, { expiresAt: now() + NEGATIVE_TTL_MS, status: error.status, type: error.type, message: error.message });
      }
      throw error;
    }
  }

  async function resolveForApi(apiPublicId, remainder) {
    const api = await getApiByPublicId(apiPublicId).catch((error) => {
      // Stale-if-error: reuse any cached artifact for this API.
      for (const artifact of artifacts.values()) {
        if (artifact?.apiPublicId === apiPublicId) {
          return { id: artifact.apiId, public_id: apiPublicId, protocol: artifact.protocol ?? "REST", __stale: true };
        }
      }
      throw error;
    });
    if (!api) {
      // Stale-if-error: same fallback when the row is gone but cache remains.
      for (const artifact of artifacts.values()) {
        if (artifact?.apiPublicId === apiPublicId) {
          return staleFor(apiPublicId, remainder, artifact);
        }
      }
      throw Object.assign(new Error(api?.protocol === "HTTP" ? "Not Found" : "Forbidden"), {
        status: "HTTP" === api?.protocol ? 404 : 403,
        type: "HTTP" === api?.protocol ? "RESOURCE_NOT_FOUND" : "MISSING_AUTHENTICATION_TOKEN",
      });
    }
    const segments = remainder.split("/").filter(Boolean);
    const first = segments[0] ?? "";
    const pointerKey = first ? `${apiPublicId}:${first}` : null;
    const cached = pointerKey ? stagePointers.get(pointerKey) : null;
    if (cached && cached.expiresAt > now()) {
      const artifact = await getDeployment(cached.deploymentId);
      return {
        apiPublicId,
        stage: first,
        artifact: { ...artifact, stage: first, stageVariables: { ...(cached.variables ?? {}) } },
        stageVariables: cached.variables ?? {},
        basePathStripped: `/${segments.slice(1).join("/")}` || "/",
        deploymentId: cached.deploymentId,
      };
    }
    // Fresh read (or TTL expired).
    if (first) {
      const stage = await getStage(api.id, first).catch(() => null);
      if (stage?.deployment_id) {
        stagePointers.set(pointerKey, { deploymentId: stage.deployment_id, variables: stage.variables ?? {}, expiresAt: now() + STAGE_TTL_MS });
        const artifact = await getDeployment(stage.deployment_id);
        // S09: canary deployment artifact + stage cache snapshot (best-effort).
        let canary = null;
        let canaryArtifact = null;
        try {
          const raw = stage.canary ?? null;
          if (raw && (raw.deploymentId ?? raw.deployment_id)) {
            const canaryId = raw.deploymentId ?? raw.deployment_id;
            canaryArtifact = await getDeployment(canaryId).catch(() => null);
            if (canaryArtifact) {
              canary = {
                deploymentId: canaryId,
                percentTraffic: raw.percentTraffic ?? raw.percent_traffic ?? 0,
                stageVariableOverrides: raw.stageVariableOverrides ?? raw.stage_variable_overrides ?? {},
                useStageCache: raw.useStageCache ?? raw.use_stage_cache ?? false,
                sticky: raw.sticky ?? null,
              };
            }
          }
        } catch {
          canary = null;
          canaryArtifact = null;
        }
        return {
          apiPublicId,
          stage: first,
          artifact: { ...artifact, stage: first, stageVariables: { ...(stage.variables ?? {}) } },
          stageVariables: stage.variables ?? {},
          basePathStripped: `/${segments.slice(1).join("/")}` || "/",
          deploymentId: stage.deployment_id,
          canary,
          canaryArtifact,
          stageCache: stageCacheFromRow(stage),
        };
      }
    }
    const fallback = await getStage(api.id, "$default").catch(() => null);
    if (fallback?.deployment_id) {
      stagePointers.set(`${apiPublicId}:$default`, {
        deploymentId: fallback.deployment_id,
        variables: fallback.variables ?? {},
        expiresAt: now() + STAGE_TTL_MS,
      });
      const artifact = await getDeployment(fallback.deployment_id).catch(() => {
        // Stale-if-error: reuse the cached artifact when the store is down.
        if (artifacts.has(fallback.deployment_id)) {
          touchLru(fallback.deployment_id);
          return artifacts.get(fallback.deployment_id);
        }
        throw new Error("fetch failed: store outage");
      });
      return {
        apiPublicId,
        stage: "$default",
        artifact: { ...artifact, stage: "$default", stageVariables: { ...(fallback.variables ?? {}) } },
        stageVariables: fallback.variables ?? {},
        basePathStripped: remainder || "/",
        deploymentId: fallback.deployment_id,
      };
    }
    // Stale-if-error for $default: when the store is down but a cached
    // artifact + pointer exist, keep serving it.
    if (api.__stale) {
      const cachedPointer = stagePointers.get(`${apiPublicId}:$default`);
      if (cachedPointer && artifacts.has(cachedPointer.deploymentId)) {
        const artifact = artifacts.get(cachedPointer.deploymentId);
        touchLru(cachedPointer.deploymentId);
        return {
          apiPublicId,
          stage: "$default",
          artifact: { ...artifact, stage: "$default", stageVariables: { ...(cachedPointer.variables ?? {}) } },
          stageVariables: cachedPointer.variables ?? {},
          basePathStripped: remainder || "/",
          deploymentId: cachedPointer.deploymentId,
        };
      }
      for (const artifact of artifacts.values()) {
        if (artifact?.apiPublicId === apiPublicId) {
          return staleFor(apiPublicId, remainder, artifact);
        }
      }
    }
    const protocol = api.protocol ?? "REST";
    throw Object.assign(new Error(protocol === "HTTP" ? "Not Found" : "Forbidden"), {
      status: protocol === "HTTP" ? 404 : 403,
      type: protocol === "HTTP" ? "RESOURCE_NOT_FOUND" : "MISSING_AUTHENTICATION_TOKEN",
    });
  }

  function staleFor(apiPublicId, remainder, artifact) {
    const segments = remainder.split("/").filter(Boolean);
    const first = segments[0] ?? "";
    const stage = first || "$default";
    const stripped = first ? `/${segments.slice(1).join("/")}` || "/" : remainder;
    return {
      apiPublicId,
      stage,
      artifact: { ...artifact, stage, stageVariables: { ...(artifact.stageVariables ?? {}) } },
      stageVariables: artifact.stageVariables ?? {},
      basePathStripped: stripped,
      deploymentId: artifact.deploymentId ?? null,
    };
  }

  return { resolve, _caches: { artifacts, stagePointers, negative } };
}
