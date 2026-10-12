// Backends behind every route: one integration per method/route (see
// catalog.js operations()), plus the private-network connectors and the
// backend client certificates. Rows mirror supabase/migrations/integrations.

import { PROJECT_ID, between, daysAgo, hoursAgo, minutesAgo, sid } from "./helpers.js";
import { personId } from "../cast.js";
import { apiId, operations } from "./catalog.js";

export const CONNECTORS = [
  { n: 1, name: "lisbon-office", description: "Agent pair in the Lisbon studio rack; reaches the ops box and the render farm.", status: "AVAILABLE", agents: 2, targets: ["ops.internal.halcyon.studio:8080", "render.internal.halcyon.studio:443"], seen: 1, created: 300 },
  { n: 2, name: "brooklyn-office", description: "Single agent on the Brooklyn NUC for the finance tools.", status: "DEGRADED", agents: 1, targets: ["finance.internal.halcyon.studio:443"], seen: 47, created: 140, message: "1 of 2 agents offline since the office network change." },
  { n: 3, name: "kestrel-warehouse", description: "Kestrel's Amsterdam warehouse WMS, read-only.", status: "AVAILABLE", agents: 2, targets: ["wms.kestrel.lan:9443"], seen: 2, created: 150 },
  { n: 4, name: "atlas-roastery-pos", description: "POS bridge in the Atlas roastery. Waiting for the first agent to register.", status: "PENDING", agents: 0, targets: ["pos.atlas.lan:8443"], seen: null, created: 3 },
];

const FUNCTION_ROUTES = new Set(["POST /webhooks/stripe", "POST /webhooks/shopify", "POST /webhooks/klaviyo"]);

function integrationRow(op) {
  const { spec, method, path, key } = op;
  const created = daysAgo(Math.max(1, spec.created - (op.n % 7) * 3));
  const ws = spec.protocol === "WEBSOCKET";
  const isFunction = FUNCTION_ROUTES.has(key);
  const isMock = (ws && key === "$disconnect") || (method === "OPTIONS");
  const viaConnector = spec.n === 7;
  const backendPath = ws ? `/ws/${key.replace("$", "")}` : path === "$default" ? "/{proxy}" : path;
  return {
    id: sid("integration", op.n),
    project_id: PROJECT_ID,
    api_id: apiId(spec.n),
    public_id: `int${String(op.n).padStart(4, "0")}`,
    type: isMock ? "MOCK" : isFunction ? "FUNCTION_PROXY" : spec.protocol === "REST" && method !== "GET" ? "HTTP" : "HTTP_PROXY",
    integration_method: isMock ? "ANY" : method === "ANY" ? "ANY" : ws ? "POST" : method,
    uri: isMock || isFunction ? null : `${spec.backend}${backendPath}`,
    function: isFunction ? { name: `fanout-${key.split("/").at(-1)}`, runtime: "nodejs22", region: "eu-west-1" } : null,
    aws: null,
    connection_type: viaConnector ? "CONNECTOR" : "INTERNET",
    connector_id: viaConnector ? sid("connector", 1) : null,
    timeout_ms: spec.n === 9 ? 10000 : spec.n === 6 ? 15000 : 29000,
    payload_format_version: spec.protocol === "HTTP" ? "2.0" : "1.0",
    passthrough_behavior: "WHEN_NO_MATCH",
    content_handling: null,
    request_parameters: spec.protocol === "REST" && path.includes("{")
      ? Object.fromEntries([...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => [`integration.request.path.${name}`, `method.request.path.${name}`]))
      : spec.n === 2 ? { "append:header.x-halcyon-launch": "aero" } : {},
    request_templates: isMock ? { "application/json": "{\"statusCode\": 200}" } : spec.protocol === "REST" && method === "POST" && path === "/checkout"
      ? { "application/json": "#set($body = $input.path('$'))\n{\n  \"cart\": \"$body.cartId\",\n  \"channel\": \"web\",\n  \"requestId\": \"$context.requestId\"\n}" }
      : {},
    response_parameters: {},
    cache_key_parameters: spec.protocol === "REST" && method === "GET" && path.includes("{") ? Object.keys(Object.fromEntries([...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => [`method.request.path.${name}`, true]))) : [],
    cache_namespace: spec.protocol === "REST" && method === "GET" ? `ns${spec.n}${op.n}` : null,
    response_transfer_mode: spec.n === 8 && method === "GET" ? "STREAM" : "BUFFERED",
    tls: { insecureSkipVerification: false, serverNameToVerify: null },
    backend_auth: spec.n === 6 ? { type: "client_certificate", clientCertificateId: sid("client_certificate", 1) } : null,
    description: isMock ? "Static response, no backend." : `${spec.name} · ${key}`,
    template_selection_expression: null,
    created_by: personId(spec.owner),
    created_at: created,
    updated_at: created,
    deleted_at: null,
    version: 1 + (op.n % 4),
  };
}

export function integrationsSeed() {
  const ops = operations();
  const integrations = ops.map(integrationRow);

  // REST integrations of type HTTP map backend status codes explicitly.
  const integration_responses = [];
  for (const row of integrations) {
    if (row.type !== "HTTP" && row.type !== "MOCK") continue;
    const created = row.created_at;
    const responses = row.type === "MOCK"
      ? [[200, null]]
      : [[200, null], [400, "4\\d{2}"], [502, "5\\d{2}"]];
    for (const [status, pattern] of responses) {
      integration_responses.push({
        id: sid("integration_response", integration_responses.length + 1),
        integration_id: row.id,
        status_code: status,
        selection_pattern: pattern,
        response_parameters: status === 200 ? { "method.response.header.Cache-Control": "'no-store'" } : {},
        response_templates: status === 502 ? { "application/json": "{\"message\": \"Upstream unavailable\", \"requestId\": \"$context.requestId\"}" } : {},
        content_handling: null,
        created_by: row.created_by,
        created_at: created,
        updated_at: created,
        deleted_at: null,
        version: 1,
      });
    }
  }

  const connectors = CONNECTORS.map((c) => ({
    id: sid("connector", c.n),
    project_id: PROJECT_ID,
    name: c.name,
    description: c.description,
    status: c.status,
    status_message: c.message ?? null,
    allowed_targets: c.targets,
    agent_count: c.agents,
    last_seen_at: c.seen === null ? null : c.seen < 10 ? minutesAgo(c.seen) : hoursAgo(c.seen),
    created_by: personId(c.n === 3 ? 9 : 2),
    created_at: daysAgo(c.created),
    updated_at: daysAgo(Math.max(0, Math.floor(c.created / 10))),
    deleted_at: null,
    version: 1 + (c.n % 3),
  }));

  const connector_tokens = CONNECTORS.flatMap((c) => Array.from({ length: Math.max(1, c.agents) }, (_, i) => {
    const n = c.n * 10 + i + 1;
    return {
      id: sid("connector_token", n),
      connector_id: sid("connector", c.n),
      token_hash: `sha256:${String(between(n, 100000, 999999))}${"0".repeat(58)}`.slice(0, 71),
      prefix: `pods_ct_${String.fromCharCode(97 + (n % 26))}${between(n + 7, 100, 999)}`,
      created_by: personId(2),
      created_at: daysAgo(Math.max(0, c.created - i * 20)),
      revoked_at: null,
    };
  }));

  const certificate = (n, description, created, expiresIn) => ({
    id: sid("client_certificate", n),
    project_id: PROJECT_ID,
    public_id: `cc${String(n).padStart(4, "0")}hal`,
    description,
    certificate_pem: `-----BEGIN CERTIFICATE-----\nMIIC${"Q".repeat(4)}halcyon${n}playgroundcertificate${"A".repeat(24)}\n-----END CERTIFICATE-----\n`,
    private_key_ref: `vault://client-certificates/${sid("client_certificate", n)}`,
    expires_at: new Date(Date.now() + expiresIn * 864e5).toISOString(),
    created_by: personId(9),
    created_at: daysAgo(created),
    deleted_at: null,
    version: 1,
  });

  const client_certificates = [
    certificate(1, "Solace bookings backend (mTLS to the PMS gateway)", 90, 275),
    certificate(2, "Kestrel storefront origin pull", 200, 24),
    certificate(3, "Studio ops — rotated after the 2026 audit", 30, 335),
  ];

  return { integrations, integration_responses, connectors, connector_tokens, client_certificates };
}
