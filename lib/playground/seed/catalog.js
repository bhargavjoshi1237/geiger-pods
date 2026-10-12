// Halcyon Studio's gateway: the APIs Halcyon runs for its clients (Kestrel's
// storefront and Aero launch, Atlas ordering, Solace bookings) and for itself
// (studio ops, asset delivery, partner webhooks). Rows mirror
// supabase/migrations/catalog (pods.apis, rest_resources, rest_methods,
// http_routes). API_SPECS also drives the traffic, release and usage seeds.

import { PROJECT_ID, daysAgo, sid } from "./helpers.js";
import { personId } from "../cast.js";

// traffic: daily requests at peak, 4XX/5XX rates, p90 latency (ms) and the
// stage cache hit share (REST only), used by ./observability.js.
export const API_SPECS = [
  {
    n: 1, key: "kestrel-storefront", publicId: "kstrlshop1", name: "Kestrel Storefront API", protocol: "REST",
    endpointType: "EDGE", client: "kestrel", created: 384, owner: 9,
    description: "Catalog, carts and checkout behind kestrelbikes.com and the Kestrel dealer app.",
    backend: "https://storefront.kestrelbikes.example",
    stages: ["prod", "staging"],
    traffic: { base: 5200, e4: 0.034, e5: 0.002, p90: 84, cache: 0.64 },
    methods: [
      ["GET", "/products"], ["GET", "/products/{productId}"], ["GET", "/products/{productId}/reviews"],
      ["POST", "/products/{productId}/reviews"], ["POST", "/carts"], ["GET", "/carts/{cartId}"],
      ["POST", "/carts/{cartId}/items"], ["DELETE", "/carts/{cartId}/items/{itemId}"], ["POST", "/checkout"],
      ["GET", "/dealers"], ["GET", "/dealers/{dealerId}"], ["GET", "/orders/{orderId}"],
      ["POST", "/orders/{orderId}/returns"], ["OPTIONS", "/products"],
    ],
  },
  {
    n: 2, key: "kestrel-preorders", publicId: "aeropre0rd", name: "Kestrel Aero Pre-orders", protocol: "HTTP",
    endpointType: "REGIONAL", client: "kestrel", created: 41, owner: 9,
    description: "Deposits and the waitlist for the Kestrel Aero launch.",
    backend: "https://aero.kestrelbikes.example",
    stages: ["prod", "dev"],
    traffic: { base: 1700, e4: 0.058, e5: 0.017, p90: 212, cache: 0 },
    routes: [
      "GET /preorders", "POST /preorders", "GET /preorders/{preorderId}", "DELETE /preorders/{preorderId}",
      "POST /preorders/{preorderId}/deposit", "GET /waitlist", "POST /waitlist",
    ],
  },
  {
    n: 3, key: "kestrel-inventory", publicId: "kstrlstock", name: "Kestrel Live Inventory", protocol: "WEBSOCKET",
    endpointType: "REGIONAL", client: "kestrel", created: 162, owner: 9,
    description: "Live stock levels pushed to dealer screens and the launch countdown page.",
    backend: "https://inventory.kestrelbikes.example",
    stages: ["production"],
    traffic: { base: 1100, e4: 0.011, e5: 0.004, p90: 23, cache: 0 },
    routes: ["$connect", "$disconnect", "$default", "subscribe", "unsubscribe", "stockLevel"],
  },
  {
    n: 4, key: "atlas-ordering", publicId: "atlas0rder", name: "Atlas Ordering API", protocol: "REST",
    endpointType: "REGIONAL", client: "atlas", created: 233, owner: 9,
    description: "Menu, mobile orders and store hours for Atlas Coffee's 14 cafés.",
    backend: "https://orders.atlascoffee.example",
    stages: ["prod", "staging"],
    traffic: { base: 3900, e4: 0.021, e5: 0.0012, p90: 61, cache: 0.48 },
    methods: [
      ["GET", "/menu"], ["GET", "/menu/{itemId}"], ["PUT", "/menu/{itemId}"], ["GET", "/orders"],
      ["POST", "/orders"], ["GET", "/orders/{orderId}"], ["PATCH", "/orders/{orderId}/status"],
      ["DELETE", "/orders/{orderId}"], ["GET", "/stores"], ["GET", "/stores/{storeId}"],
      ["GET", "/stores/{storeId}/hours"], ["PUT", "/stores/{storeId}/hours"],
    ],
  },
  {
    n: 5, key: "atlas-loyalty", publicId: "atlasl0yal", name: "Atlas Loyalty", protocol: "HTTP",
    endpointType: "REGIONAL", client: "atlas", created: 118, owner: 5,
    description: "Stamp cards and rewards for the Atlas app.",
    backend: "https://loyalty.atlascoffee.example",
    stages: ["prod", "dev"],
    traffic: { base: 1450, e4: 0.026, e5: 0.003, p90: 47, cache: 0 },
    routes: [
      "GET /members/{memberId}", "POST /members", "GET /members/{memberId}/points",
      "POST /members/{memberId}/stamps", "GET /rewards", "POST /rewards/redeem",
    ],
  },
  {
    n: 6, key: "solace-bookings", publicId: "s0lacebook", name: "Solace Bookings API", protocol: "REST",
    endpointType: "REGIONAL", client: "solace", created: 96, owner: 9,
    description: "Availability and reservations for the Solace Summer '26 campaign landing pages.",
    backend: "https://bookings.solacehotels.example",
    stages: ["prod", "staging"],
    traffic: { base: 2300, e4: 0.041, e5: 0.006, p90: 138, cache: 0.31 },
    methods: [
      ["GET", "/hotels"], ["GET", "/hotels/{hotelId}"], ["GET", "/hotels/{hotelId}/availability"],
      ["GET", "/offers"], ["POST", "/reservations"], ["GET", "/reservations/{reservationId}"],
      ["PATCH", "/reservations/{reservationId}"], ["DELETE", "/reservations/{reservationId}"],
    ],
  },
  {
    n: 7, key: "studio-ops", publicId: "halcy0nops", name: "Studio Ops API", protocol: "REST",
    endpointType: "PRIVATE", client: null, created: 310, owner: 2,
    description: "Halcyon's internal tools: timesheets, budgets, people and expenses. Reached through the Lisbon connector.",
    backend: "http://ops.internal.halcyon.studio:8080",
    stages: ["prod"],
    traffic: { base: 640, e4: 0.015, e5: 0.001, p90: 96, cache: 0.22 },
    methods: [
      ["GET", "/timesheets"], ["POST", "/timesheets"], ["GET", "/projects"], ["GET", "/projects/{projectId}/budget"],
      ["GET", "/people"], ["GET", "/people/{personId}"], ["GET", "/expenses"], ["POST", "/expenses"],
    ],
  },
  {
    n: 8, key: "asset-delivery", publicId: "h4lcyncdn1", name: "Asset Delivery (beta)", protocol: "HTTP",
    endpointType: "REGIONAL", client: null, created: 9, owner: 7,
    description: "Signed rendition URLs for Halcyon's asset library. In beta, not yet announced.",
    backend: "https://assets.halcyon.studio",
    stages: ["beta"],
    traffic: null,
    routes: ["GET /assets/{assetId}", "GET /assets/{assetId}/renditions/{size}", "POST /uploads"],
  },
  {
    n: 9, key: "partner-webhooks", publicId: "partnrhook", name: "Partner Webhooks", protocol: "HTTP",
    endpointType: "REGIONAL", client: null, created: 205, owner: 9,
    description: "Inbound webhooks from Stripe, Shopify and Klaviyo, fanned out to client backends.",
    backend: "https://hooks.halcyon.studio",
    stages: ["prod"],
    traffic: { base: 420, e4: 0.03, e5: 0.068, p90: 640, cache: 0 },
    routes: ["POST /webhooks/stripe", "POST /webhooks/shopify", "POST /webhooks/klaviyo", "$default"],
  },
];

export const apiId = (n) => sid("api", n);
export const apiSpec = (key) => API_SPECS.find((spec) => spec.key === key);

// Authorizers referenced by methods/routes; ./auth.js seeds the rows.
export const AUTHORIZER_REFS = [
  { n: 1, api: 2, name: "kestrel-customers", type: "JWT" },
  { n: 2, api: 1, name: "dealer-portal", type: "CUSTOM" },
  { n: 3, api: 7, name: "halcyon-sso", type: "JWT" },
  { n: 4, api: 4, name: "atlas-staff", type: "CUSTOM" },
];

// Which operations need what: [apiN, matcher, { authorizer, scopes, apiKey }].
const AUTH_RULES = [
  [1, (m, p) => p.startsWith("/dealers"), { authorizer: 2 }],
  [1, (m) => m !== "GET" && m !== "OPTIONS", { apiKey: true }],
  [2, (m, p) => p !== "/waitlist", { authorizer: 1, scopes: ["preorders:write"] }],
  [4, (m) => m !== "GET", { authorizer: 4 }],
  [4, () => true, { apiKey: true }],
  [6, () => true, { apiKey: true }],
  [7, () => true, { authorizer: 3, scopes: ["ops:read"] }],
  [3, (m, p) => p === "$connect", { apiKey: true }],
];

function authFor(apiN, method, path) {
  const out = { authorization_type: "NONE", authorizer_id: null, authorization_scopes: [], api_key_required: false };
  for (const [n, test, rule] of AUTH_RULES) {
    if (n !== apiN || !test(method, path)) continue;
    if (rule.apiKey) out.api_key_required = true;
    if (rule.authorizer) {
      const ref = AUTHORIZER_REFS.find((entry) => entry.n === rule.authorizer);
      out.authorization_type = ref.type;
      out.authorizer_id = sid("authorizer", ref.n);
      out.authorization_scopes = rule.scopes ?? [];
    }
  }
  return out;
}

function operationName(method, path) {
  const words = path.split("/").filter(Boolean).map((part) => part.replace(/[{}+]/g, ""));
  const last = words.at(-1) ?? "root";
  const verb = { GET: path.endsWith("}") ? "get" : "list", POST: "create", PUT: "replace", PATCH: "update", DELETE: "delete", OPTIONS: "preflight" }[method] ?? method.toLowerCase();
  return `${verb}${last.charAt(0).toUpperCase()}${last.slice(1)}`;
}

function corsFor(spec) {
  if (spec.protocol !== "HTTP" || spec.n === 9) return null;
  const origin = { atlas: "https://app.atlascoffee.example", kestrel: "https://aero.kestrelbikes.example" }[spec.client] ?? "https://halcyon.studio";
  return {
    allowOrigins: [origin], allowMethods: ["GET", "POST", "DELETE", "OPTIONS"], allowHeaders: ["authorization", "content-type"],
    exposeHeaders: ["x-request-id"], maxAge: 600, allowCredentials: true,
  };
}

function apiRow(spec) {
  return {
    id: apiId(spec.n),
    project_id: PROJECT_ID,
    public_id: spec.publicId,
    name: spec.name,
    description: spec.description,
    protocol: spec.protocol,
    api_version: spec.protocol === "WEBSOCKET" ? null : spec.n === 1 ? "2026-09" : "v1",
    endpoint_type: spec.endpointType,
    ip_address_type: spec.n === 1 ? "dualstack" : "ipv4",
    disable_default_endpoint: spec.n === 1,
    api_key_source: "HEADER",
    api_key_selection_expression: spec.protocol === "WEBSOCKET" ? "$request.header.x-api-key" : null,
    binary_media_types: spec.n === 7 ? ["application/pdf"] : [],
    minimum_compression_size: spec.n === 1 ? 1024 : null,
    route_selection_expression: spec.protocol === "WEBSOCKET" ? "$request.body.action" : spec.protocol === "HTTP" ? "$request.method $request.path" : null,
    cors: corsFor(spec),
    resource_policy: spec.n === 7
      ? { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "execute-api:Invoke", Resource: "execute-api:/*", Condition: { IpAddress: { "aws:SourceIp": ["10.20.0.0/16", "192.0.2.0/24"] } } }] }
      : null,
    missing_route_behavior: spec.n === 1 || spec.protocol === "HTTP" ? "not_found" : "aws",
    tags: { team: spec.client ? "client-platform" : "studio-ops", ...(spec.client ? { client: spec.client } : {}) },
    metadata: {},
    created_by: personId(spec.owner),
    created_at: daysAgo(spec.created),
    updated_at: daysAgo(Math.max(1, Math.floor(spec.created / 9)), spec.n),
    deleted_at: null,
    version: 2 + (spec.n % 5),
  };
}

// Every method/route gets its own integration: ./integrations.js seeds one per
// operation, so operation n's integration is sid("integration", n).
export function operations() {
  const out = [];
  for (const spec of API_SPECS) {
    for (const [method, path] of spec.methods ?? []) out.push({ spec, method, path, key: `${method} ${path}` });
    for (const key of spec.routes ?? []) {
      const [method, path] = key.includes(" ") ? key.split(" ") : ["ANY", key];
      out.push({ spec, method, path, key });
    }
  }
  return out.map((op, index) => ({ ...op, n: index + 1 }));
}

export function catalogSeed() {
  const rest_resources = [];
  const rest_methods = [];
  const http_routes = [];
  const resourceByPath = new Map();

  const addResource = (spec, path) => {
    const key = `${spec.n}:${path}`;
    if (resourceByPath.has(key)) return resourceByPath.get(key);
    const parentPath = path === "/" ? null : path.slice(0, path.lastIndexOf("/")) || "/";
    const parent = parentPath === null ? null : addResource(spec, parentPath);
    const created = daysAgo(spec.created);
    const row = {
      id: sid("rest_resource", rest_resources.length + 1),
      project_id: PROJECT_ID,
      api_id: apiId(spec.n),
      parent_id: parent?.id ?? null,
      path_part: path === "/" ? "" : path.slice(path.lastIndexOf("/") + 1),
      path,
      metadata: {},
      created_by: personId(spec.owner),
      created_at: created,
      updated_at: created,
      deleted_at: null,
      version: 1,
    };
    resourceByPath.set(key, row);
    rest_resources.push(row);
    return row;
  };

  for (const op of operations()) {
    const { spec, method, path } = op;
    const created = daysAgo(Math.max(1, spec.created - (op.n % 7) * 3));
    const auth = authFor(spec.n, method, path);
    if (spec.protocol === "REST") {
      addResource(spec, "/");
      const resource = addResource(spec, path);
      const params = Object.fromEntries([...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => [`method.request.path.${name}`, true]));
      rest_methods.push({
        id: sid("rest_method", op.n),
        project_id: PROJECT_ID,
        api_id: apiId(spec.n),
        resource_id: resource.id,
        http_method: method,
        ...auth,
        operation_name: operationName(method, path),
        request_validator_id: null,
        request_parameters: method === "GET" && !path.endsWith("}") ? { ...params, "method.request.querystring.limit": false } : params,
        request_models: method === "POST" || method === "PUT" ? { "application/json": "Empty" } : {},
        integration_id: sid("integration", op.n),
        settings: {},
        metadata: {},
        created_by: personId(spec.owner),
        created_at: created,
        updated_at: created,
        deleted_at: null,
        version: 1 + (op.n % 3),
      });
    } else {
      http_routes.push({
        id: sid("http_route", op.n),
        project_id: PROJECT_ID,
        api_id: apiId(spec.n),
        route_key: op.key,
        ...auth,
        integration_id: sid("integration", op.n),
        operation_name: spec.protocol === "WEBSOCKET" ? op.key.replace("$", "") : operationName(method, path),
        request_parameters: {},
        request_models: {},
        model_selection_expression: spec.protocol === "WEBSOCKET" && op.key === "subscribe" ? "$request.body.channel" : null,
        route_response_selection_expression: spec.protocol === "WEBSOCKET" && !op.key.startsWith("$") ? "$default" : null,
        metadata: {},
        created_by: personId(spec.owner),
        created_at: created,
        updated_at: created,
        deleted_at: null,
        version: 1 + (op.n % 3),
      });
    }
  }

  return {
    apis: API_SPECS.map(apiRow),
    rest_resources,
    rest_methods,
    http_routes,
  };
}
