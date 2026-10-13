// "AniList Explorer" — the flagship REST pod. A clean REST façade over
// AniList's GraphQL API, built in four phases so the deployment history has
// real diffs: each phase adds endpoints, then deploys.

import { createApi, listApis } from "../../../lib/control/apis.mjs";
import { createResource, putMethod } from "../../../lib/control/rest-resources.mjs";
import { createIntegration, createIntegrationResponse, updateIntegrationResponse } from "../../../lib/control/integrations.mjs";
import { createMethodResponse } from "../../../lib/control/method-responses.mjs";
import { createModel } from "../../../lib/control/models.mjs";
import { createRequestValidator } from "../../../lib/control/request-validators.mjs";
import { putGatewayResponse } from "../../../lib/control/gateway-responses.mjs";
import { createAuthorizer } from "../../../lib/control/authorizers.mjs";
import { enableCors } from "../../../lib/control/enable-cors.mjs";
import { updateResourcePolicy } from "../../../lib/control/resource-policies.mjs";
import { createDeployment } from "../../../lib/control/deployments.mjs";
import { ANILIST_URL, ENDPOINTS } from "../endpoints.mjs";
import { body, items, sleep } from "../context.mjs";

export const REST_API_NAME = "AniList Explorer";

const PHASES = [
  {
    description: "v1.0 — Anime lookups: detail, search and trending behind API keys",
    paths: ["/anime/{id}", "/anime/search", "/anime/trending"],
    extras: ["health"],
  },
  {
    description: "v1.1 — Manga, characters, staff & studios; response models, validators and branded errors",
    paths: ["/anime/seasonal/{year}/{season}", "/anime/{id}/characters", "/anime/{id}/recommendations", "/manga/{id}", "/manga/search", "/characters/{id}", "/staff/{id}", "/studios/{id}"],
    extras: ["models", "gatewayResponses"],
  },
  {
    description: "v1.2 — GraphQL passthrough, Geiger SSO (/me), partner exports, airing schedule, CORS and IP policy",
    paths: ["/users/{name}", "/schedule/airing"],
    extras: ["graphql", "me", "partners", "similar", "cors", "policy"],
  },
  {
    description: "v1.3 — Streaming links per anime (canary)",
    paths: [],
    extras: ["streaming"],
  },
];

const MODELS = [
  {
    name: "Error",
    description: "Branded error envelope returned by every failure path.",
    schema: {
      $schema: "http://json-schema.org/draft-04/schema#", title: "Error", type: "object",
      properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, requestId: { type: "string" } }, required: ["code", "message"] } },
    },
  },
  {
    name: "Anime",
    description: "One AniList anime, flattened.",
    schema: {
      $schema: "http://json-schema.org/draft-04/schema#", title: "Anime", type: "object",
      properties: {
        id: { type: "integer" },
        title: { type: "object", properties: { romaji: { type: "string" }, english: { type: ["string", "null"] }, native: { type: ["string", "null"] } } },
        format: { type: "string" }, status: { type: "string" }, season: { type: "string" },
        episodes: { type: ["integer", "null"] }, score: { type: ["integer", "null"] }, popularity: { type: "integer" },
        genres: { type: "array", items: { type: "string" } }, cover: { type: "string" }, url: { type: "string" },
      },
      required: ["id", "title"],
    },
  },
  {
    name: "MediaList",
    description: "Search / trending / seasonal result page.",
    schema: {
      $schema: "http://json-schema.org/draft-04/schema#", title: "MediaList", type: "object",
      properties: {
        count: { type: "integer" },
        results: { type: "array", items: { type: "object", properties: { id: { type: "integer" }, title: { type: ["string", "null"] }, romaji: { type: "string" }, score: { type: ["integer", "null"] } } } },
      },
    },
  },
  {
    name: "Character",
    description: "Character profile.",
    schema: {
      $schema: "http://json-schema.org/draft-04/schema#", title: "Character", type: "object",
      properties: { id: { type: "integer" }, name: { type: "object" }, favourites: { type: "integer" }, appearsIn: { type: "array" } },
    },
  },
  {
    name: "GraphQLRequest",
    description: "Body accepted by POST /graphql (validated before it reaches AniList).",
    schema: {
      $schema: "http://json-schema.org/draft-04/schema#", title: "GraphQLRequest", type: "object",
      properties: { query: { type: "string", minLength: 3, maxLength: 8000 }, variables: { type: "object" }, operationName: { type: "string" } },
      required: ["query"], additionalProperties: false,
    },
  },
];

/** Which model documents each endpoint's 200 response. */
const RESPONSE_MODEL = {
  "/anime/{id}": "Anime",
  "/anime/search": "MediaList",
  "/anime/trending": "MediaList",
  "/anime/seasonal/{year}/{season}": "MediaList",
  "/manga/search": "MediaList",
  "/characters/{id}": "Character",
};

/** Branded upstream-error mapping shared by every AniList integration. */
function errorTemplate(code, message) {
  return `{"error": {"code": "${code}", "message": "${message}", "requestId": "$context.requestId"}, "upstream": $input.json('$.errors[0].message')}`;
}

const UPSTREAM_ERRORS = [
  { statusCode: 400, selectionPattern: "400", template: errorTemplate("BAD_QUERY", "AniList rejected the query. Check the path and query parameters.") },
  { statusCode: 404, selectionPattern: "404", template: errorTemplate("NOT_FOUND", "AniList has no entry matching that request.") },
  { statusCode: 429, selectionPattern: "429", template: errorTemplate("UPSTREAM_BUSY", "AniList is rate limiting the gateway. Cached responses keep flowing; retry in a minute.") },
  { statusCode: 502, selectionPattern: "5\\d{2}", template: errorTemplate("UPSTREAM_UNAVAILABLE", "AniList is having a moment. Please retry shortly.") },
];

const GATEWAY_RESPONSES = {
  DEFAULT_4XX: [null, "REQUEST_REJECTED", "$context.error.message"],
  DEFAULT_5XX: [null, "GATEWAY_ERROR", "Something went wrong between Pods and AniList."],
  MISSING_AUTHENTICATION_TOKEN: [404, "NO_SUCH_ROUTE", "That route does not exist. See the AniList Developer Hub for the catalog."],
  INVALID_API_KEY: [403, "INVALID_API_KEY", "Send a valid key in the x-api-key header. Get one from the AniList Developer Hub."],
  THROTTLED: [429, "SLOW_DOWN", "Too many requests for your plan. Take a breather — even Saitama rests between punches."],
  QUOTA_EXCEEDED: [429, "QUOTA_EXCEEDED", "You have used this period's quota. Upgrade your plan in the Developer Hub."],
  UNAUTHORIZED: [401, "SIGN_IN_REQUIRED", "Sign in with your Geiger account and send the access token as a Bearer token."],
  ACCESS_DENIED: [403, "ACCESS_DENIED", "$context.error.message"],
  BAD_REQUEST_PARAMETERS: [400, "MISSING_PARAMETER", "$context.error.validationErrorString"],
  BAD_REQUEST_BODY: [400, "INVALID_BODY", "$context.error.validationErrorString"],
  WAF_FILTERED: [403, "BLOCKED", "This request was blocked by the AniList Edge Shield firewall."],
  INTEGRATION_TIMEOUT: [504, "UPSTREAM_TIMEOUT", "AniList did not answer within 10 seconds."],
};

export async function seedRestApi(ctx, state) {
  const { db, actor, projectId, log } = ctx;
  log.section(`REST API · ${REST_API_NAME}`);

  const apis = items(await listApis(db, actor, { projectId, limit: 100 }));
  let api = apis.find((row) => row.name === REST_API_NAME);
  if (!api) {
    api = body(await createApi(db, actor, {
      projectId,
      name: REST_API_NAME,
      protocol: "REST",
      description: "Clean REST endpoints over the AniList GraphQL API: anime, manga, characters, staff, studios and the airing schedule. Pods injects attribution headers, caches hot lookups, meters every consumer key and turns AniList's GraphQL errors into branded JSON.",
      apiVersion: "2026-10",
      endpointType: "REGIONAL",
      apiKeySource: "HEADER",
      minimumCompressionSize: 1024,
      missingRouteBehavior: "aws",
      tags: { team: "anime-platform", upstream: "anilist", tier: "showcase" },
    }));
    log.item(`+ API ${api.name} (${api.publicId})`);
  } else {
    log.skip(`API ${api.name} (${api.publicId})`);
  }
  state.rest = { apiId: api.id, publicId: api.publicId, name: api.name, deployments: [] };
  const apiId = api.id;
  const cache = await catalogCache(db, { projectId, apiId });

  for (const [index, phase] of PHASES.entries()) {
    log.item(`phase ${index + 1}: ${phase.description}`);
    for (const extra of phase.extras) await EXTRAS[extra](ctx, state, cache);
    for (const path of phase.paths) {
      const endpoint = ENDPOINTS.find((entry) => entry.path === path);
      await ensureAniListEndpoint(ctx, state, cache, endpoint);
    }
    const deployment = await ensureDeployment(ctx, { apiId, description: phase.description });
    state.rest.deployments.push(deployment);
  }
}

/** Existing draft rows, refreshed as the step writes. */
async function catalogCache(db, { projectId, apiId }) {
  const cache = {
    projectId,
    apiId,
    resources: new Map(),
    async refresh() {
      this.resources = new Map((await db.listResourcesByApi({ apiId })).map((row) => [row.path, row]));
      this.methods = await db.listMethodsByApi({ apiId });
      this.integrations = await db.listIntegrations({ apiId, limit: 500 });
      this.models = await db.listModels({ projectId, apiId });
      this.validators = await db.listRequestValidators({ projectId, apiId });
      this.authorizers = await db.listAuthorizers({ projectId, apiId });
    },
    method(resourceId, httpMethod) {
      return this.methods.find((row) => row.resource_id === resourceId && row.http_method === httpMethod && !row.deleted_at) ?? null;
    },
  };
  await cache.refresh();
  return cache;
}

async function ensureResourcePath(ctx, cache, path) {
  if (cache.resources.has(path)) return cache.resources.get(path);
  const slash = path.lastIndexOf("/");
  const parentPath = slash === 0 ? "/" : path.slice(0, slash);
  const parent = await ensureResourcePath(ctx, cache, parentPath);
  const created = body(await createResource(ctx.db, ctx.actor, {
    projectId: ctx.projectId, apiId: cache.apiId, parentId: parent.id, pathPart: path.slice(slash + 1),
  }));
  const row = { id: created.id, path: created.path };
  cache.resources.set(path, row);
  return row;
}

async function ensureIntegration(ctx, cache, key, input) {
  const description = `${input.description} [${key}]`;
  const found = cache.integrations.find((row) => (row.description ?? "").endsWith(`[${key}]`) && !row.deleted_at);
  if (found) return { integration: found, created: false };
  const integration = body(await createIntegration(ctx.db, ctx.actor, {
    projectId: ctx.projectId, apiId: cache.apiId, input: { ...input, description },
  }));
  cache.integrations.push({ ...integration, description });
  return { integration, created: true };
}

async function ensureMethod(ctx, cache, { path, httpMethod, fields, methodResponses = [], integrationResponses = [] }) {
  const resource = await ensureResourcePath(ctx, cache, path);
  let method = cache.method(resource.id, httpMethod);
  if (method) {
    ctx.log.skip(`${httpMethod} ${path}`);
  } else {
    method = body(await putMethod(ctx.db, ctx.actor, {
      projectId: ctx.projectId, apiId: cache.apiId, resourceId: resource.id, httpMethod, fields,
    }));
    cache.methods.push({ id: method.id, resource_id: resource.id, http_method: httpMethod });
    ctx.log.item(`+ ${httpMethod} ${path}${fields.apiKeyRequired ? " (API key)" : ""}${fields.authorizationType && fields.authorizationType !== "NONE" ? ` (${fields.authorizationType})` : ""}`);
  }
  // Responses are created separately, so fill in any a failed run left out.
  const haveMethod = new Set((await ctx.db.listMethodResponses({ methodId: method.id })).map((row) => String(row.status_code)));
  for (const response of methodResponses) {
    if (haveMethod.has(String(response.statusCode))) continue;
    await createMethodResponse(ctx.db, ctx.actor, { projectId: ctx.projectId, apiId: cache.apiId, methodId: method.id, input: response });
  }
  if (fields.integrationId) {
    const existing = await ctx.db.listIntegrationResponses({ integrationId: fields.integrationId });
    const haveIntegration = new Set(existing.map((row) => String(row.status_code)));
    for (const response of integrationResponses) {
      const current = existing.find((row) => String(row.status_code) === String(response.statusCode));
      if (current && response.responseTemplates
        && JSON.stringify(current.response_templates ?? {}) !== JSON.stringify(response.responseTemplates)) {
        // Converge the draft on the current template (shows up as an undeployed change).
        await updateIntegrationResponse(ctx.db, ctx.actor, {
          projectId: ctx.projectId, apiId: cache.apiId, integrationId: fields.integrationId, responseId: current.id,
          patch: { responseTemplates: response.responseTemplates },
        });
        ctx.log.item(`  ~ ${httpMethod} ${path}: ${response.statusCode} template updated in draft`);
      }
      if (haveIntegration.has(String(response.statusCode))) continue;
      await createIntegrationResponse(ctx.db, ctx.actor, {
        projectId: ctx.projectId, apiId: cache.apiId, integrationId: fields.integrationId, input: response,
      });
    }
  }
  return method;
}

function validatorId(cache, name) {
  return cache.validators.find((row) => row.name === name)?.id ?? null;
}

/** Backend credential injection: every AniList call carries the vault-held attribution header. */
function upstreamTag(state) {
  return { type: "header", secretRef: `secret:${state.secrets["anilist-upstream-tag"]}`, headerName: "X-Geiger-Client" };
}

async function ensureAniListEndpoint(ctx, state, cache, endpoint) {
  const requestParameters = {};
  for (const name of endpoint.pathParams ?? []) requestParameters[`method.request.path.${name}`] = true;
  for (const [name, required] of Object.entries(endpoint.queryParams ?? {})) requestParameters[`method.request.querystring.${name}`] = required;
  const hasRequired = Object.values(requestParameters).some(Boolean);
  const { integration } = await ensureIntegration(ctx, cache, endpoint.operationName, {
    type: "HTTP",
    integrationMethod: "POST",
    uri: ANILIST_URL,
    timeoutMs: 10000,
    passthroughBehavior: "WHEN_NO_TEMPLATES",
    description: `AniList GraphQL · ${endpoint.summary}`,
    requestParameters: {
      "integration.request.header.Content-Type": "'application/json'",
      "integration.request.header.Accept": "'application/json'",
    },
    requestTemplates: { "application/json": endpoint.requestTemplate },
    cacheKeyParameters: endpoint.cacheKey,
    cacheNamespace: endpoint.operationName,
    backendAuth: upstreamTag(state),
  });
  const publicTeaser = endpoint.path === "/anime/trending";
  await ensureMethod(ctx, cache, {
    path: endpoint.path,
    httpMethod: "GET",
    fields: {
      authorizationType: "NONE",
      apiKeyRequired: !publicTeaser,
      operationName: endpoint.operationName,
      requestParameters,
      requestValidatorId: hasRequired ? validatorId(cache, "Validate query string and path") : null,
      integrationId: integration.id,
    },
    methodResponses: [
      {
        statusCode: "200",
        responseParameters: { "method.response.header.X-RateLimit-Remaining": false, "method.response.header.Cache-Control": false },
        responseModels: RESPONSE_MODEL[endpoint.path] && cache.models.some((m) => m.name === RESPONSE_MODEL[endpoint.path])
          ? { "application/json": RESPONSE_MODEL[endpoint.path] } : {},
      },
      ...UPSTREAM_ERRORS.map((error) => ({
        statusCode: String(error.statusCode),
        responseModels: cache.models.some((m) => m.name === "Error") ? { "application/json": "Error" } : {},
      })),
    ],
    integrationResponses: [
      {
        statusCode: 200,
        responseParameters: {
          "method.response.header.X-RateLimit-Remaining": "integration.response.header.X-RateLimit-Remaining",
          "method.response.header.Cache-Control": "'public, max-age=300'",
        },
        responseTemplates: { "application/json": endpoint.response },
      },
      ...UPSTREAM_ERRORS.map((error) => ({
        statusCode: error.statusCode,
        selectionPattern: error.selectionPattern,
        responseTemplates: { "application/json": error.template },
      })),
    ],
  });
}

async function ensureDeployment(ctx, { apiId, description }) {
  const existing = (await ctx.db.listDeployments({ apiId, limit: 100 })).find((row) => row.description === description);
  if (existing) {
    ctx.log.skip(`deployment "${description.split(" — ")[0]}"`);
    return existing;
  }
  await sleep(2100); // createDeployment allows one deploy per API every 2 s.
  const deployment = body(await createDeployment(ctx.db, ctx.actor, { projectId: ctx.projectId, apiId, description }));
  ctx.log.item(`⇪ deployed ${description.split(" — ")[0]} (${deployment.publicId ?? deployment.id})${deployment.warnings?.length ? ` · ${deployment.warnings.length} warning(s)` : ""}`);
  return deployment;
}

// --- Phase extras -------------------------------------------------------------

const EXTRAS = {
  async health(ctx, state, cache) {
    if (!cache.validators.some((row) => row.name === "Validate query string and path")) {
      cache.validators.push(body(await createRequestValidator(ctx.db, ctx.actor, {
        projectId: ctx.projectId, apiId: cache.apiId,
        input: { name: "Validate query string and path", validateRequestBody: false, validateRequestParameters: true },
      })));
      ctx.log.item("+ request validator: query string and path");
    }
    const { integration } = await ensureIntegration(ctx, cache, "Health", {
      type: "MOCK",
      description: "Liveness probe answered by the gateway itself",
      requestTemplates: { "application/json": "{\"statusCode\": 200}" },
    });
    await ensureMethod(ctx, cache, {
      path: "/health",
      httpMethod: "GET",
      fields: { authorizationType: "NONE", apiKeyRequired: false, operationName: "Health", integrationId: integration.id },
      methodResponses: [{ statusCode: "200" }],
      integrationResponses: [{
        statusCode: 200,
        responseTemplates: {
          "application/json": "{\"status\": \"ok\", \"service\": \"AniList Explorer\", \"stage\": \"$context.stage\", \"requestId\": \"$context.requestId\", \"time\": \"$context.requestTime\"}",
        },
      }],
    });
  },

  async models(ctx, state, cache) {
    for (const model of MODELS) {
      if (cache.models.some((row) => row.name === model.name)) continue;
      cache.models.push(body(await createModel(ctx.db, ctx.actor, {
        projectId: ctx.projectId, apiId: cache.apiId,
        input: { name: model.name, schema: model.schema, contentType: "application/json", description: model.description },
      })));
      ctx.log.item(`+ model ${model.name}`);
    }
    if (!cache.validators.some((row) => row.name === "Validate body")) {
      cache.validators.push(body(await createRequestValidator(ctx.db, ctx.actor, {
        projectId: ctx.projectId, apiId: cache.apiId,
        input: { name: "Validate body", validateRequestBody: true, validateRequestParameters: false },
      })));
      ctx.log.item("+ request validator: body");
    }
  },

  async gatewayResponses(ctx, state, cache) {
    for (const [type, [statusCode, code, message]] of Object.entries(GATEWAY_RESPONSES)) {
      await putGatewayResponse(ctx.db, ctx.actor, {
        projectId: ctx.projectId, apiId: cache.apiId, responseType: type,
        input: {
          statusCode: statusCode === null ? null : String(statusCode),
          responseParameters: { "gatewayresponse.header.Access-Control-Allow-Origin": "'*'", "gatewayresponse.header.X-Pods-Error": `'${code}'` },
          responseTemplates: {
            "application/json": `{"error": {"code": "${code}", "message": "${message}", "requestId": "$context.requestId"}, "docs": "https://anime.geiger-notes.dev/docs/errors#${code.toLowerCase()}"}`,
          },
        },
      });
    }
    ctx.log.item(`= ${Object.keys(GATEWAY_RESPONSES).length} branded gateway responses`);
  },

  async graphql(ctx, state, cache) {
    const { integration } = await ensureIntegration(ctx, cache, "GraphQLProxy", {
      type: "HTTP_PROXY",
      integrationMethod: "POST",
      uri: ANILIST_URL,
      timeoutMs: 15000,
      description: "Raw GraphQL passthrough to AniList (validated body, injected attribution header)",
      backendAuth: upstreamTag(state),
    });
    await ensureMethod(ctx, cache, {
      path: "/graphql",
      httpMethod: "POST",
      fields: {
        authorizationType: "NONE",
        apiKeyRequired: true,
        operationName: "GraphQLQuery",
        requestModels: { "application/json": "GraphQLRequest" },
        requestValidatorId: validatorId(cache, "Validate body"),
        integrationId: integration.id,
      },
      methodResponses: [{ statusCode: "200" }],
    });
  },

  async me(ctx, state, cache) {
    let sso = cache.authorizers.find((row) => row.name === "Geiger Suite SSO");
    if (!sso) {
      const issuer = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1`;
      sso = body(await createAuthorizer(ctx.db, ctx.actor, {
        projectId: ctx.projectId, apiId: cache.apiId,
        input: {
          name: "Geiger Suite SSO",
          type: "JWT",
          identitySource: ["$request.header.Authorization"],
          resultTtlSeconds: 300,
          jwt: { issuer, audience: ["authenticated"], algorithms: ["ES256"], clockSkewSec: 60 },
        },
      }));
      cache.authorizers.push(sso);
      ctx.log.item(`+ JWT authorizer Geiger Suite SSO (${issuer})`);
    }
    const { integration } = await ensureIntegration(ctx, cache, "WhoAmI", {
      type: "MOCK",
      description: "Echoes the verified Geiger identity from the JWT authorizer",
      requestTemplates: { "application/json": "{\"statusCode\": 200}" },
    });
    await ensureMethod(ctx, cache, {
      path: "/me",
      httpMethod: "GET",
      fields: { authorizationType: "JWT", authorizerId: sso.id, apiKeyRequired: false, operationName: "WhoAmI", integrationId: integration.id },
      methodResponses: [{ statusCode: "200" }],
      integrationResponses: [{
        statusCode: 200,
        responseTemplates: {
          "application/json": "{\"userId\": \"$context.authorizer.claims.sub\", \"email\": \"$context.authorizer.claims.email\", \"role\": \"$context.authorizer.claims.role\", \"verifiedBy\": \"Geiger Suite SSO\"}",
        },
      }],
    });
  },

  async partners(ctx, state, cache) {
    let partner = cache.authorizers.find((row) => row.name === "Partner token");
    if (!partner) {
      partner = body(await createAuthorizer(ctx.db, ctx.actor, {
        projectId: ctx.projectId, apiId: cache.apiId,
        input: {
          name: "Partner token",
          type: "TOKEN",
          identitySource: ["method.request.header.X-Partner-Token"],
          identityValidationExpression: "^ptk_[A-Za-z0-9]{24,}$",
          resultTtlSeconds: 300,
          function: { provider: "webhook", url: "https://partners.geiger-notes.dev/pods/authorize" },
        },
      }));
      cache.authorizers.push(partner);
      ctx.log.item("+ TOKEN authorizer Partner token (webhook)");
    }
    const { integration } = await ensureIntegration(ctx, cache, "PartnerExport", {
      type: "MOCK",
      description: "Queues a bulk catalog export for a partner",
      requestTemplates: { "application/json": "{\"statusCode\": 202}" },
    });
    await ensureMethod(ctx, cache, {
      path: "/partners/exports",
      httpMethod: "POST",
      fields: { authorizationType: "CUSTOM", authorizerId: partner.id, apiKeyRequired: true, operationName: "CreatePartnerExport", integrationId: integration.id },
      methodResponses: [{ statusCode: "202" }],
      integrationResponses: [{
        statusCode: 202,
        responseTemplates: { "application/json": "{\"exportId\": \"$context.requestId\", \"status\": \"queued\", \"partner\": \"$context.authorizer.principalId\"}" },
      }],
    });
  },

  async similar(ctx, state, cache) {
    const connector = state.connectors?.recs;
    if (!connector) throw new Error("networking step must run before the REST API (connector missing)");
    const { integration } = await ensureIntegration(ctx, cache, "SimilarAnime", {
      type: "HTTP_PROXY",
      integrationMethod: "GET",
      uri: "http://recs.geiger.internal:8080/v2/similar/{id}",
      connectionType: "CONNECTOR",
      connectorId: connector,
      timeoutMs: 5000,
      description: "On-prem recommendation engine reached through the Pods Connector",
      requestParameters: { "integration.request.path.id": "method.request.path.id" },
      backendAuth: { type: "basic_auth", secretRef: `secret:${state.secrets["recs-engine-basic-auth"]}` },
    });
    await ensureMethod(ctx, cache, {
      path: "/anime/{id}/similar",
      httpMethod: "GET",
      fields: {
        authorizationType: "NONE", apiKeyRequired: true, operationName: "SimilarAnime",
        requestParameters: { "method.request.path.id": true },
        requestValidatorId: validatorId(cache, "Validate query string and path"),
        integrationId: integration.id,
      },
      methodResponses: [{ statusCode: "200" }],
    });
  },

  async cors(ctx, state, cache) {
    for (const path of ["/anime/{id}", "/anime/search", "/anime/trending", "/graphql"]) {
      const resource = cache.resources.get(path);
      if (!resource || cache.method(resource.id, "OPTIONS")) continue;
      await enableCors(ctx.db, ctx.actor, {
        projectId: ctx.projectId, apiId: cache.apiId, resourceId: resource.id,
        input: {
          allowOrigin: "'*'",
          allowMethods: path === "/graphql" ? ["POST", "OPTIONS"] : ["GET", "OPTIONS"],
          allowHeaders: ["Content-Type", "X-Api-Key", "Authorization"],
          includeGatewayResponses: path === "/anime/{id}",
        },
      });
      cache.methods.push({ resource_id: resource.id, http_method: "OPTIONS" });
      ctx.log.item(`+ CORS on ${path}`);
    }
  },

  async policy(ctx, state, cache) {
    await updateResourcePolicy(ctx.db, ctx.actor, {
      projectId: ctx.projectId, apiId: cache.apiId,
      document: {
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Principal: "*", Action: "execute-api:Invoke", Resource: "arn:pods:execute-api:*" },
          {
            Effect: "Deny", Principal: "*", Action: "execute-api:Invoke", Resource: "arn:pods:execute-api:*",
            Condition: { IpAddress: { "aws:SourceIp": ["203.0.113.0/24", "198.51.100.66/32"] } },
          },
        ],
      },
    });
    ctx.log.item("= resource policy: allow all, deny two scraper ranges");
  },

  async streaming(ctx, state, cache) {
    const endpoint = {
      path: "/anime/{id}/streaming",
      operationName: "AnimeStreaming",
      summary: "Where to watch: official streaming links",
      pathParams: ["id"],
      cacheKey: ["method.request.path.id"],
      requestTemplate: "{\"query\": \"query ($id: Int) { Media(id: $id, type: ANIME) { id title { romaji } externalLinks { site url type language } streamingEpisodes { title url site } } }\", \"variables\": {\"id\": #if($input.params('id').matches(\"^[0-9]+$\"))$input.params('id')#else 0#end}}",
      response: "{\"id\": $input.json('$.data.Media.id'), \"title\": $input.json('$.data.Media.title.romaji'), \"links\": $input.json('$.data.Media.externalLinks'), \"episodes\": $input.json('$.data.Media.streamingEpisodes')}",
    };
    await ensureAniListEndpoint(ctx, state, cache, endpoint);
  },
};
