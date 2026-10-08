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
 * Vault ref for a stage's cache DEK (F29): the engine resolves
 * `cache-dek:<stageId>` through `ports.secrets` (vault-backed per-stage
 * secret provisioned by `ensureStageCacheDek`), falling back to the derived
 * default only when unprovisioned (loud in production). The loader carries
 * the ref — never the material — alongside `stageCache`.
 *
 * @param {string} stageId - `${apiPublicId}:${stage}`.
 * @returns {string}
 */
export function stageCacheDekRef(stageId) {
  return `cache-dek:${String(stageId ?? "")}`;
}

/**
 * Stage observability settings for the emit phase (F50, S10 §3–§5).
 *
 * Mutable stage settings travel separately from the immutable artifact: the
 * loader attaches the mapped object as `resolved.stageObservability` and the
 * gateway host copies it to `ctx.stageSettings`, which is the emit phase's
 * primary settings source (see `stageSettingsOf` in `phases/emit.mjs`).
 * Accepts a Supabase `stages` row (snake_case) or an already-mapped object
 * (camelCase, e.g. a memory-loader fixture); missing values fall back to
 * the emit-phase defaults (access log off, logging OFF, tracing off).
 *
 * @param {object|null} stage - Stage row or settings object.
 * @returns {object|null} Emit-phase settings, or null when `stage` is null.
 */
export function stageObservabilityFromRow(stage) {
  if (!stage || typeof stage !== "object") return null;
  const accessLog = stage.accessLog ?? stage.access_log ?? null;
  return {
    accessLog: accessLog ?? null,
    loggingLevel: stage.loggingLevel ?? stage.default_logging_level ?? "OFF",
    dataTraceEnabled: stage.dataTraceEnabled ?? stage.default_data_trace ?? false,
    tracingEnabled: stage.tracingEnabled ?? stage.tracing_enabled ?? false,
    methodSettings: stage.methodSettings ?? stage.method_settings ?? {},
    routeSettings: stage.routeSettings ?? stage.route_settings ?? {},
  };
}

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
 * `{ artifact, stageVariables?, deploymentId?, stageCache?, stageObservability?,
 * agentTools? }`. `customDomains` is the S11
 * fixture list: `{ domainName, status?, routingMode?, mappings: [{ apiPublicId,
 * stage, basePath }], rules? }` (checked before the default host pattern).
 *
 * @param {{ artifacts?: Map<string, object>|Record<string, object>, stages?: Map<string, object>|Record<string, object>,
 *   domain?: string|null, pathRouting?: boolean, kv?: object|null, customDomains?: Array<object> }} [options={}]
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
  const customDomains = options.customDomains ?? [];

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
    // S11: custom domains resolve before the default host pattern. An
    // unverified domain (or a miss under ROUTING_RULE_ONLY) answers here;
    // other hosts fall through to the default handling below.
    if (customDomains.length > 0) {
      const hit = await resolveCustom(cleanHost, cleanPath);
      if (hit) return hit;
    }
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
   * S11 custom-domain resolution against the fixture list. Returns null when
   * no configured domain matches (fall through to default handling).
   *
   * @param {string} cleanHost
   * @param {string} cleanPath
   */
  async function resolveCustom(cleanHost, cleanPath) {
    const { matchDomain, resolveCustomDomain } = await import("../lib/gateway/core/edge/host-resolve.mjs");
    for (const entry of customDomains) {
      if (!matchDomain(entry.domainName, cleanHost).matched) continue;
      const resolved = resolveCustomDomain({
        host: cleanHost,
        path: cleanPath,
        headers: {},
        domain: { domainName: entry.domainName, status: entry.status ?? "AVAILABLE", routingMode: entry.routingMode ?? "API_MAPPING_ONLY" },
        mappings: entry.mappings ?? [],
        rules: entry.rules ?? [],
      });
      if (resolved.error === "notFound") {
        throw Object.assign(new Error("Not Found"), { status: 404, type: "RESOURCE_NOT_FOUND" });
      }
      if (resolved.error) {
        throw Object.assign(new Error("Forbidden"), { status: 403, type: "ACCESS_DENIED" });
      }
      const key = `${resolved.apiId}:${resolved.stage}`;
      if (!stages.has(key)) {
        throw Object.assign(new Error("Forbidden"), { status: 403, type: "ACCESS_DENIED" });
      }
      const stageEntry = stages.get(key);
      const artifact = stageEntry.artifact ?? stageEntry;
      return {
        apiPublicId: resolved.apiId,
        stage: resolved.stage,
        artifact: withStage(artifact, resolved.stage, stageEntry.stageVariables ?? artifact.stageVariables),
        stageVariables: stageEntry.stageVariables ?? artifact.stageVariables ?? {},
        basePathStripped: resolved.strippedPath,
        deploymentId: stageEntry.deploymentId ?? artifact.deploymentId ?? null,
        canary: stageEntry.canary ?? artifact.canary ?? null,
        canaryArtifact: stageEntry.canaryArtifact ?? artifact.canaryArtifact ?? null,
        stageCache: stageEntry.stageCache ?? artifact.stageCache ?? null,
        // F50: stage observability settings travel alongside the base artifact.
        stageObservability: stageEntry.stageObservability
          ?? artifact.stageSettings?.[resolved.stage]
          ?? null,
        // S13E: the MCP agent-tools opt-in travels with the stage pointer.
        agentTools: stageEntry.agentTools ?? artifact.agentTools ?? null,
        domainName: cleanHost,
        viaDefaultEndpoint: false,
        customDomainMatch: {
          strippedPath: resolved.strippedPath,
          routingRuleId: resolved.routingRuleId,
          basePathMatched: resolved.basePathMatched,
          domainPrefix: resolved.domainPrefix,
          domainName: cleanHost,
          apiPublicId: resolved.apiId,
          stage: resolved.stage,
          // F34: private-domain enforcement inputs (null/empty = skip).
          endpointType: entry.endpointType ?? "REGIONAL",
          policy: entry.policy ?? null,
          associatedConnectorIds: entry.associatedConnectorIds ?? [],
        },
      };
    }
    return null;
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
        // F50: stage observability settings travel alongside the base artifact.
        stageObservability: entry.stageObservability
          ?? artifact.stageSettings?.[first]
          ?? null,
        // S13E: the MCP agent-tools opt-in travels alongside the base artifact.
        agentTools: entry.agentTools ?? artifact.agentTools ?? null,
        viaDefaultEndpoint: true,
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
        // F50: stage observability settings travel alongside the base artifact.
        stageObservability: entry.stageObservability
          ?? artifact.stageSettings?.["$default"]
          ?? null,
        agentTools: entry.agentTools ?? artifact.agentTools ?? null,
        viaDefaultEndpoint: true,
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
      .select("id, api_id, name, deployment_id, variables, canary, agent_tools, method_settings, route_settings, access_log, tracing_enabled, default_logging_level, default_data_trace, cache_cluster_enabled, cache_cluster_size, cache_default_ttl, cache_data_encrypted, require_authorization_for_cache_control, unauthorized_cache_control_header_strategy")
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
   * S11: custom-domain resolution from `pods.domain_names` (+ mappings and
   * routing rules). Best-effort: any store error falls through to the
   * default host handling. Results share the 5 s negative cache above.
   *
   * @param {string} cleanHost
   * @param {string} cleanPath
   * @returns {Promise<object|null>}
   */
  async function resolveCustomFromStore(cleanHost, cleanPath) {
    const { matchDomain, resolveCustomDomain } = await import("../lib/gateway/core/edge/host-resolve.mjs");
    const labels = cleanHost.split(".");
    const candidates = [cleanHost];
    if (labels.length > 2) candidates.push(`*.${labels.slice(1).join(".")}`);
    let domain = null;
    for (const name of candidates) {
      const { data } = await supabase.schema("pods").from("domain_names")
        .select("id, domain_name, status, routing_mode, target_hostname, endpoint_type, policy")
        .eq("domain_name", name)
        .is("deleted_at", null)
        .maybeSingle();
      if (data && matchDomain(data.domain_name, cleanHost).matched) {
        domain = data;
        break;
      }
    }
    if (!domain) return null;
    // F34: private-domain enforcement inputs (best-effort; missing tables or
    // errors mean "no private inputs", never a failure).
    let associatedConnectorIds = [];
    try {
      const { data: assocRows } = await supabase.schema("pods").from("domain_access_associations")
        .select("connector_id")
        .eq("domain_id", domain.id);
      associatedConnectorIds = (assocRows ?? []).map((row) => row.connector_id).filter(Boolean);
    } catch {
      associatedConnectorIds = [];
    }
    const { data: mappingRows } = await supabase.schema("pods").from("api_mappings")
      .select("api_id, stage_name, base_path")
      .eq("domain_id", domain.id);
    const { data: ruleRows } = await supabase.schema("pods").from("routing_rules")
      .select("id, priority, conditions, action")
      .eq("domain_id", domain.id)
      .order("priority", { ascending: true });
    // Map internal api uuids to public ids for the resolver.
    const apiIds = [...new Set([
      ...(mappingRows ?? []).map((row) => row.api_id),
      ...(ruleRows ?? []).flatMap((row) => row.action?.invokeApi?.apiId ? [row.action.invokeApi.apiId] : []),
    ])];
    const publicById = new Map();
    for (const apiId of apiIds) {
      const { data: api } = await supabase.schema("pods").from("apis")
        .select("id, public_id")
        .eq("id", apiId)
        .is("deleted_at", null)
        .maybeSingle();
      if (api) publicById.set(api.id, api.public_id);
    }
    const resolved = resolveCustomDomain({
      host: cleanHost,
      path: cleanPath,
      headers: {},
      domain: { domainName: domain.domain_name, status: domain.status, routingMode: domain.routing_mode },
      mappings: (mappingRows ?? []).map((row) => ({
        apiPublicId: publicById.get(row.api_id) ?? row.api_id,
        stage: row.stage_name,
        basePath: row.base_path,
      })),
      rules: (ruleRows ?? []).map((row) => ({
        id: row.id,
        priority: row.priority,
        conditions: row.conditions,
        action: {
          invokeApi: {
            apiId: publicById.get(row.action?.invokeApi?.apiId) ?? row.action?.invokeApi?.apiId,
            stage: row.action?.invokeApi?.stage,
            stripBasePath: row.action?.invokeApi?.stripBasePath ?? false,
          },
        },
      })),
    });
    if (resolved.error === "notFound") {
      throw Object.assign(new Error("Not Found"), { status: 404, type: "RESOURCE_NOT_FOUND" });
    }
    if (resolved.error) {
      throw Object.assign(new Error("Forbidden"), { status: 403, type: "ACCESS_DENIED" });
    }
    const out = await resolveForApi(resolved.apiId, `/${resolved.stage}${resolved.strippedPath}`);
    return {
      ...out,
      basePathStripped: resolved.strippedPath,
      domainName: cleanHost,
      viaDefaultEndpoint: false,
      customDomainMatch: {
        strippedPath: resolved.strippedPath,
        routingRuleId: resolved.routingRuleId,
        basePathMatched: resolved.basePathMatched,
        domainPrefix: resolved.domainPrefix,
        domainName: cleanHost,
        apiPublicId: resolved.apiId,
        stage: resolved.stage,
        // F34: private-domain enforcement inputs.
        endpointType: domain.endpoint_type ?? "REGIONAL",
        policy: domain.policy ?? null,
        associatedConnectorIds,
      },
    };
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
      // S11: custom domains first (best-effort; falls through on store error).
      try {
        const custom = await resolveCustomFromStore(cleanHost, cleanPath);
        if (custom) return custom;
      } catch (error) {
        if (error && typeof error.status === "number" && (error.status === 403 || error.status === 404)) throw error;
        // Store/shape errors fall through to default handling.
      }
      if (usePathRouting || !gatewayDomain || !cleanHost.endsWith(`.${String(gatewayDomain).toLowerCase()}`)) {
        const segments = cleanPath.split("/").filter(Boolean);
        const apiPublicId = segments[0] ?? "";
        if (!apiPublicId) throw Object.assign(new Error("Not Found"), { status: 404, type: "RESOURCE_NOT_FOUND" });
        const resolved = await resolveForApi(apiPublicId, `/${segments.slice(1).join("/")}` || "/");
        return { viaDefaultEndpoint: true, ...resolved };
      }
      const suffix = `.${String(gatewayDomain).toLowerCase()}`;
      const apiPublicId = cleanHost.slice(0, -suffix.length);
      if (!apiPublicId || apiPublicId.includes(".")) {
        throw Object.assign(new Error("Forbidden"), { status: 403, type: "ACCESS_DENIED" });
      }
      const resolved = await resolveForApi(apiPublicId, cleanPath);
      return { viaDefaultEndpoint: true, ...resolved };
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
          // F50: stage observability settings from the stage row.
          stageObservability: stageObservabilityFromRow(stage),
          // S13E: the MCP agent-tools opt-in travels with the stage row.
          agentTools: stage.agent_tools ?? null,
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
        // F50: stage observability settings from the stage row.
        stageObservability: stageObservabilityFromRow(fallback),
        // S13E: the MCP agent-tools opt-in travels with the stage row.
        agentTools: fallback.agent_tools ?? null,
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
