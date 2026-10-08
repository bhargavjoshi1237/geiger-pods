/**
 * Published limits (S15 §1 — single source of truth).
 *
 * Defaults match AWS. `adjustable` means a project override in
 * `project_settings.features.limits` (set by Geiger staff via SQL, not by
 * users). Every limit has one constant here; the control plane (409/422
 * `limit_exceeded { limit, value }`) and the runtime both use these
 * constants. `docs/limits.md` is generated from this module by
 * `scripts/gen-limits-doc.mjs` (a test checks they stay in sync).
 *
 * Request-size predicates (`exceedsBodyLimit`, `exceedsUrlLimit`,
 * `exceedsHeaderLimit`) predate S15 (S01) and stay here for compatibility;
 * per-protocol tunings below (`HEADER_BYTES`, `URL_LENGTH`) are what S15
 * enforces.
 *
 * @module lib/gateway/core/limits
 */

// --- Request sizes (S01 predicates; S15 per-protocol values below) --------

/**
 * Default limits. `S15` owns enforcement and per-protocol tuning.
 * @type {{ maxBodyBytes: number, maxHeaderValueBytes: number, maxUrlLengthChars: number, maxHeaderCount: number }}
 */
export const LIMITS = {
  maxBodyBytes: 10 * 1024 * 1024,
  maxHeaderValueBytes: 10 * 1024,
  maxUrlLengthChars: 8192,
  maxHeaderCount: 100,
};

/**
 * Pure predicate: is this body byte length over the payload limit?
 *
 * @param {number} bytes
 * @param {{ maxBodyBytes?: number }} [limits=LIMITS]
 * @returns {boolean}
 */
export function exceedsBodyLimit(bytes, limits = LIMITS) {
  return bytes > (limits.maxBodyBytes ?? LIMITS.maxBodyBytes);
}

/**
 * Pure predicate: is this URL string over the URL length limit?
 *
 * @param {string} url
 * @param {{ maxUrlLengthChars?: number }} [limits=LIMITS]
 * @returns {boolean}
 */
export function exceedsUrlLimit(url, limits = LIMITS) {
  return url.length > (limits.maxUrlLengthChars ?? LIMITS.maxUrlLengthChars);
}

/**
 * Pure predicate: are headers over the count/value-size limits?
 *
 * @param {Headers} headers
 * @param {{ maxHeaderValueBytes?: number, maxHeaderCount?: number }} [limits=LIMITS]
 * @returns {boolean}
 */
export function exceedsHeaderLimit(headers, limits = LIMITS) {
  const maxValue = limits.maxHeaderValueBytes ?? LIMITS.maxHeaderValueBytes;
  const maxCount = limits.maxHeaderCount ?? LIMITS.maxHeaderCount;
  const encoder = new TextEncoder();
  let count = 0;
  for (const [, value] of headers) {
    count += 1;
    if (encoder.encode(value).length > maxValue) return true;
  }
  return count > maxCount;
}

// --- Published limit table (S15 §1) ----------------------------------------
// Each entry: `{ default, adjustable, unit?, description }`. `default` may be
// a scalar or a `{ variant: value }` map for per-protocol rows. The `LIMITS`
// export above stays for the S01 predicates; `LIMIT_TABLE` is the §1 table.

/** APIs per project by endpoint type. */
export const MAX_APIS_PER_PROJECT_REGIONAL = 600;
export const MAX_APIS_PER_PROJECT_PRIVATE = 600;
export const MAX_APIS_PER_PROJECT_EDGE = 120;
/** Catalog. */
export const MAX_RESOURCES_PER_REST_API = 300;
export const MAX_ROUTES_PER_HTTP_API = 300;
export const MAX_ROUTES_PER_WS_API = 300;
export const MAX_INTEGRATIONS_PER_HTTP_API = 300;
export const MAX_STAGES_PER_API = 10;
export const MAX_STAGE_VARIABLES_PER_STAGE = 100;
export const MAX_STAGE_VARIABLE_KEY_CHARS = 64;
export const MAX_STAGE_VARIABLE_VALUE_CHARS = 512;
export const MAX_AUTHORIZERS_PER_API = 10;
export const MAX_JWT_AUDIENCES_PER_AUTHORIZER = 50;
export const MAX_SCOPES_PER_ROUTE = 10;
export const MAX_MODELS_BYTES_PER_API = 400 * 1024;
export const MAX_DOCUMENTATION_PARTS_PER_API = 2000;
export const MAX_API_KEYS_PER_PROJECT = 10_000;
export const MAX_USAGE_PLANS_PER_PROJECT = 300;
export const MAX_PLANS_PER_KEY = 10;
export const MAX_METHOD_THROTTLES_PER_PLAN_STAGE = 20;
export const MAX_CUSTOM_DOMAINS_PER_PROJECT_PUBLIC = 120;
export const MAX_CUSTOM_DOMAINS_PER_PROJECT_PRIVATE = 50;
export const MAX_MAPPINGS_PER_DOMAIN = 200;
export const MAX_ROUTING_RULES_PER_DOMAIN = 50;
export const MAX_CONNECTORS_PER_PROJECT = 20;
export const MAX_CLIENT_CERTS_PER_PROJECT = 60;
export const MAX_TRUSTSTORE_CERTS = 1000;
export const MAX_TRUSTSTORE_BYTES = 1024 * 1024;
export const MAX_RESOURCE_POLICY_CHARS = 8192;
export const MAX_ACCESS_LOG_FORMAT_BYTES = 3 * 1024;
export const MAX_MAPPING_TEMPLATE_BYTES = 300 * 1024;
export const MAX_FOREACH_ITERATIONS = 1000;
export const MAX_IMPORT_BYTES = 6 * 1024 * 1024;
export const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_HEADER_BYTES_REST = 20_480;
export const MAX_HEADER_BYTES_HTTP = 10_240;
export const MAX_URL_LENGTH_REGIONAL = 10_240;
export const MAX_URL_LENGTH_EDGE = 8192;
export const MAX_URL_LENGTH_PRIVATE = 8192;
export const MIN_INTEGRATION_TIMEOUT_MS = 50;
export const MAX_INTEGRATION_TIMEOUT_MS_REST = 29_000;
export const MAX_INTEGRATION_TIMEOUT_MS_HTTP = 30_000;
export const MAX_INTEGRATION_TIMEOUT_MS_RAISED = 300_000;
export const MAX_KEEP_ALIVE_SECONDS = 310;
export const MAX_CACHE_TTL_SECONDS = 3600;
export const MAX_CACHE_ITEM_BYTES = 1024 * 1024;
export const MAX_STREAMING_SECONDS_REGIONAL = 15 * 60;
export const MAX_STREAMING_SECONDS_EDGE = 5 * 60;
export const MAX_STREAMING_IDLE_SECONDS = 30;
export const MAX_WS_MESSAGE_BYTES = 128 * 1024;
export const MAX_WS_FRAME_BYTES = 32 * 1024;
export const MAX_WS_DURATION_MS = 2 * 60 * 60 * 1000;
export const MAX_WS_IDLE_MS = 10 * 60 * 1000;
export const MAX_WS_CONNECTS_PER_SECOND_PER_PROJECT = 500;
export const MAX_PROJECT_THROTTLE_RPS = 10_000;
export const MAX_PROJECT_THROTTLE_BURST = 5_000;
export const MAX_CONTROL_RPS = 10;
export const MAX_CONTROL_BURST = 40;

/**
 * Machine-readable §1 table for docs generation + per-row tests.
 * `key` is the stable limit name used in `limit_exceeded` details.
 */
export const LIMIT_TABLE = [
  { key: "apis_per_project_regional", default: MAX_APIS_PER_PROJECT_REGIONAL, adjustable: true, description: "APIs per project (regional)" },
  { key: "apis_per_project_private", default: MAX_APIS_PER_PROJECT_PRIVATE, adjustable: true, description: "APIs per project (private)" },
  { key: "apis_per_project_edge", default: MAX_APIS_PER_PROJECT_EDGE, adjustable: true, description: "APIs per project (edge)" },
  { key: "resources_per_rest_api", default: MAX_RESOURCES_PER_REST_API, adjustable: true, description: "Resources per REST API" },
  { key: "routes_per_http_api", default: MAX_ROUTES_PER_HTTP_API, adjustable: true, description: "Routes per HTTP API" },
  { key: "routes_per_ws_api", default: MAX_ROUTES_PER_WS_API, adjustable: true, description: "Routes per WebSocket API" },
  { key: "integrations_per_http_api", default: MAX_INTEGRATIONS_PER_HTTP_API, adjustable: true, description: "Integrations per HTTP API" },
  { key: "stages_per_api", default: MAX_STAGES_PER_API, adjustable: true, description: "Stages per API" },
  { key: "stage_variables_per_stage", default: MAX_STAGE_VARIABLES_PER_STAGE, adjustable: false, description: "Stage variables per stage (key 64, value 512 chars)" },
  { key: "authorizers_per_api", default: MAX_AUTHORIZERS_PER_API, adjustable: true, description: "Authorizers per API" },
  { key: "jwt_audiences_per_authorizer", default: MAX_JWT_AUDIENCES_PER_AUTHORIZER, adjustable: false, description: "JWT audiences per authorizer" },
  { key: "scopes_per_route", default: MAX_SCOPES_PER_ROUTE, adjustable: false, description: "Scopes per route" },
  { key: "models_bytes_per_api", default: MAX_MODELS_BYTES_PER_API, adjustable: false, description: "Models size per API (bytes)" },
  { key: "documentation_parts_per_api", default: MAX_DOCUMENTATION_PARTS_PER_API, adjustable: true, description: "Documentation parts per API" },
  { key: "api_keys_per_project", default: MAX_API_KEYS_PER_PROJECT, adjustable: false, description: "API keys per project" },
  { key: "usage_plans_per_project", default: MAX_USAGE_PLANS_PER_PROJECT, adjustable: true, description: "Usage plans per project" },
  { key: "plans_per_key", default: MAX_PLANS_PER_KEY, adjustable: true, description: "Usage plans per key" },
  { key: "method_throttles_per_plan_stage", default: MAX_METHOD_THROTTLES_PER_PLAN_STAGE, adjustable: true, description: "Method throttles per plan stage" },
  { key: "custom_domains_public_per_project", default: MAX_CUSTOM_DOMAINS_PER_PROJECT_PUBLIC, adjustable: true, description: "Custom domains per project (public)" },
  { key: "custom_domains_private_per_project", default: MAX_CUSTOM_DOMAINS_PER_PROJECT_PRIVATE, adjustable: true, description: "Custom domains per project (private)" },
  { key: "mappings_per_domain", default: MAX_MAPPINGS_PER_DOMAIN, adjustable: false, description: "Multi-level mappings per domain" },
  { key: "routing_rules_per_domain", default: MAX_ROUTING_RULES_PER_DOMAIN, adjustable: true, description: "Routing rules per domain" },
  { key: "connectors_per_project", default: MAX_CONNECTORS_PER_PROJECT, adjustable: true, description: "Connectors per project" },
  { key: "client_certs_per_project", default: MAX_CLIENT_CERTS_PER_PROJECT, adjustable: true, description: "Client certificates per project" },
  { key: "truststore_certs", default: MAX_TRUSTSTORE_CERTS, adjustable: false, description: "Trust store certs" },
  { key: "truststore_bytes", default: MAX_TRUSTSTORE_BYTES, adjustable: false, description: "Trust store bytes" },
  { key: "resource_policy_chars", default: MAX_RESOURCE_POLICY_CHARS, adjustable: true, description: "Resource policy length (chars)" },
  { key: "access_log_format_bytes", default: MAX_ACCESS_LOG_FORMAT_BYTES, adjustable: false, description: "Access log format (bytes)" },
  { key: "mapping_template_bytes", default: MAX_MAPPING_TEMPLATE_BYTES, adjustable: false, description: "Mapping template size (bytes)" },
  { key: "foreach_iterations", default: MAX_FOREACH_ITERATIONS, adjustable: false, description: "#foreach iterations" },
  { key: "import_bytes", default: MAX_IMPORT_BYTES, adjustable: false, description: "Import file size (bytes)" },
  { key: "payload_bytes", default: MAX_PAYLOAD_BYTES, adjustable: false, description: "Payload request/response buffered (bytes)" },
  { key: "header_bytes_rest", default: MAX_HEADER_BYTES_REST, adjustable: false, description: "Header bytes total (REST)" },
  { key: "header_bytes_http", default: MAX_HEADER_BYTES_HTTP, adjustable: false, description: "Header bytes total (HTTP)" },
  { key: "url_length_regional", default: MAX_URL_LENGTH_REGIONAL, adjustable: false, description: "URL length regional (chars)" },
  { key: "url_length_edge", default: MAX_URL_LENGTH_EDGE, adjustable: false, description: "URL length edge (chars)" },
  { key: "url_length_private", default: MAX_URL_LENGTH_PRIVATE, adjustable: false, description: "URL length private (chars)" },
  { key: "integration_timeout_rest_ms", default: MAX_INTEGRATION_TIMEOUT_MS_REST, adjustable: true, description: "Integration timeout REST/WS (ms, raisable to 300s)" },
  { key: "integration_timeout_http_ms", default: MAX_INTEGRATION_TIMEOUT_MS_HTTP, adjustable: false, description: "Integration timeout HTTP (ms)" },
  { key: "keep_alive_seconds", default: MAX_KEEP_ALIVE_SECONDS, adjustable: false, description: "Idle client connection keep-alive (s)" },
  { key: "cache_ttl_seconds", default: MAX_CACHE_TTL_SECONDS, adjustable: false, description: "Cache TTL (s)" },
  { key: "cache_item_bytes", default: MAX_CACHE_ITEM_BYTES, adjustable: false, description: "Cached item (bytes)" },
  { key: "streaming_seconds_regional", default: MAX_STREAMING_SECONDS_REGIONAL, adjustable: false, description: "Streaming duration regional (s)" },
  { key: "streaming_seconds_edge", default: MAX_STREAMING_SECONDS_EDGE, adjustable: false, description: "Streaming duration edge (s)" },
  { key: "streaming_idle_seconds", default: MAX_STREAMING_IDLE_SECONDS, adjustable: false, description: "Streaming idle (s)" },
  { key: "ws_message_bytes", default: MAX_WS_MESSAGE_BYTES, adjustable: false, description: "WS message (bytes)" },
  { key: "ws_frame_bytes", default: MAX_WS_FRAME_BYTES, adjustable: false, description: "WS frame (bytes)" },
  { key: "ws_duration_ms", default: MAX_WS_DURATION_MS, adjustable: false, description: "WS connection duration (ms)" },
  { key: "ws_idle_ms", default: MAX_WS_IDLE_MS, adjustable: false, description: "WS idle (ms)" },
  { key: "ws_connects_per_second_per_project", default: MAX_WS_CONNECTS_PER_SECOND_PER_PROJECT, adjustable: true, description: "WS new connections per second per project" },
  { key: "project_throttle_rps", default: MAX_PROJECT_THROTTLE_RPS, adjustable: true, description: "Project throttle (rps)" },
  { key: "project_throttle_burst", default: MAX_PROJECT_THROTTLE_BURST, adjustable: true, description: "Project throttle (burst)" },
  { key: "control_rps", default: MAX_CONTROL_RPS, adjustable: false, description: "Control plane (rps)" },
  { key: "control_burst", default: MAX_CONTROL_BURST, adjustable: false, description: "Control plane (burst)" },
];

/**
 * Resolves the effective limit for `key`, applying a project override when
 * the limit is adjustable. Overrides come from
 * `project_settings.features.limits` (`{ [key]: number }`, staff-set via
 * SQL). Non-adjustable limits ignore overrides.
 *
 * @param {string} key - `LIMIT_TABLE` key.
 * @param {Record<string,number>} [overrides={}]
 * @returns {number}
 */
export function getLimit(key, overrides = {}) {
  const entry = LIMIT_TABLE.find((row) => row.key === key);
  if (!entry) throw new TypeError(`Unknown limit "${key}".`);
  if (entry.adjustable) {
    const raw = overrides?.[key];
    if (raw !== undefined && raw !== null) {
      const next = Number(raw);
      if (Number.isFinite(next) && next >= 0) return Math.trunc(next);
    }
  }
  return entry.default;
}

/**
 * Returns true when `count` exceeds the limit (strictly greater).
 *
 * @param {string} key
 * @param {number} count
 * @param {Record<string,number>} [overrides={}]
 * @returns {boolean}
 */
export function exceedsCountLimit(key, count, overrides = {}) {
  return Number(count) > getLimit(key, overrides);
}

/**
 * UI helper: usage vs limit for list screens (S15 §1: show near the cap).
 *
 * @param {number} count
 * @param {number} limit
 * @returns {{ percent: number, nearCap: boolean }}
 */
export function limitUsage(count, limit) {
  const percent = limit > 0 ? Number(count) / Number(limit) : 0;
  return { percent, nearCap: percent >= 0.8 };
}
