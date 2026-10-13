// "AniList GraphQL Edge" (HTTP API) and "AniList Live" (WebSocket API).

import { createApi, listApis } from "../../../lib/control/apis.mjs";
import { putCors } from "../../../lib/control/cors.mjs";
import { createRoute } from "../../../lib/control/http-routes.mjs";
import { createIntegration } from "../../../lib/control/integrations.mjs";
import { createAuthorizer } from "../../../lib/control/authorizers.mjs";
import { createRouteResponse } from "../../../lib/control/route-responses.mjs";
import { createModel } from "../../../lib/control/models.mjs";
import { createDeployment } from "../../../lib/control/deployments.mjs";
import { ANILIST_URL } from "../endpoints.mjs";
import { body, items, sleep } from "../context.mjs";

export const HTTP_API_NAME = "AniList GraphQL Edge";
export const WS_API_NAME = "AniList Live";

async function ensureApi(ctx, name, input) {
  const apis = items(await listApis(ctx.db, ctx.actor, { projectId: ctx.projectId, limit: 100 }));
  const existing = apis.find((row) => row.name === name);
  if (existing) {
    ctx.log.skip(`API ${name} (${existing.publicId})`);
    return existing;
  }
  const api = body(await createApi(ctx.db, ctx.actor, { projectId: ctx.projectId, name, ...input }));
  ctx.log.item(`+ API ${name} (${api.publicId})`);
  return api;
}

async function ensureIntegration(ctx, apiId, key, input) {
  const existing = (await ctx.db.listIntegrations({ apiId, limit: 200 })).find((row) => (row.description ?? "").endsWith(`[${key}]`));
  if (existing) return existing;
  return body(await createIntegration(ctx.db, ctx.actor, {
    projectId: ctx.projectId, apiId, input: { ...input, description: `${input.description} [${key}]` },
  }));
}

async function ensureRoute(ctx, apiId, routeKey, fields) {
  const existing = (await ctx.db.listRoutesByApi({ apiId })).find((row) => row.route_key === routeKey && !row.deleted_at);
  if (existing) {
    ctx.log.skip(`route ${routeKey}`);
    return existing;
  }
  const route = body(await createRoute(ctx.db, ctx.actor, { projectId: ctx.projectId, apiId, routeKey, ...fields }));
  ctx.log.item(`+ route ${routeKey}${fields.authorizationType && fields.authorizationType !== "NONE" ? ` (${fields.authorizationType})` : ""}`);
  return route;
}

async function ensureDeployment(ctx, apiId, description) {
  const existing = (await ctx.db.listDeployments({ apiId, limit: 50 })).find((row) => row.description === description);
  if (existing) return existing;
  await sleep(2100);
  const deployment = body(await createDeployment(ctx.db, ctx.actor, { projectId: ctx.projectId, apiId, description }));
  ctx.log.item(`⇪ deployed "${description}"`);
  return deployment;
}

export async function seedHttpApi(ctx, state) {
  const { db, actor, projectId, log } = ctx;
  log.section(`HTTP API · ${HTTP_API_NAME}`);
  const api = await ensureApi(ctx, HTTP_API_NAME, {
    protocol: "HTTP",
    description: "Low-latency GraphQL edge for first-party apps: raw AniList GraphQL with CORS for the web client, Geiger SSO for viewer queries, and a pass-through to anilist.co pages.",
    apiVersion: "2026-10",
    tags: { team: "anime-platform", upstream: "anilist", protocol: "http" },
  });
  state.http = { apiId: api.id, publicId: api.publicId, name: api.name };

  await putCors(db, actor, {
    projectId, apiId: api.id,
    input: {
      allowOrigins: ["https://anime.geiger-notes.dev", "https://notes.geiger.studio", "http://localhost:3000"],
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["content-type", "authorization", "x-api-key"],
      exposeHeaders: ["x-ratelimit-remaining", "x-pods-request-id"],
      maxAge: 600,
      allowCredentials: false,
    },
  });
  log.item("= CORS: 3 origins, 10 min preflight cache");

  let sso = (await db.listAuthorizers({ projectId, apiId: api.id })).find((row) => row.name === "Geiger Suite SSO");
  if (!sso) {
    sso = body(await createAuthorizer(db, actor, {
      projectId, apiId: api.id,
      input: {
        name: "Geiger Suite SSO", type: "JWT", identitySource: ["$request.header.Authorization"],
        jwt: { issuer: `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1`, audience: ["authenticated"], algorithms: ["ES256"], clockSkewSec: 60 },
      },
    }));
    log.item("+ JWT authorizer Geiger Suite SSO");
  }

  const graphql = await ensureIntegration(ctx, api.id, "EdgeGraphQL", {
    type: "HTTP_PROXY",
    integrationMethod: "POST",
    uri: ANILIST_URL,
    payloadFormatVersion: "1.0",
    timeoutMs: 15000,
    description: "AniList GraphQL with edge headers",
    requestParameters: { "append:header.x-forwarded-by": "geiger-pods-edge", "remove:header.cookie": "''" },
    responseParameters: { "200": { "overwrite:header.x-served-by": "Geiger Pods" } },
    backendAuth: { type: "header", secretRef: `secret:${state.secrets["anilist-upstream-tag"]}`, headerName: "X-Geiger-Client" },
  });
  const site = await ensureIntegration(ctx, api.id, "SitePassthrough", {
    type: "HTTP_PROXY",
    integrationMethod: "GET",
    uri: "https://anilist.co/{proxy}",
    payloadFormatVersion: "1.0",
    timeoutMs: 10000,
    description: "Pass-through to anilist.co pages (greedy path)",
  });

  await ensureRoute(ctx, api.id, "POST /graphql", { authorizationType: "NONE", operationName: "EdgeGraphQL", integrationId: graphql.id });
  await ensureRoute(ctx, api.id, "POST /graphql/viewer", {
    authorizationType: "JWT", authorizerId: sso.id, operationName: "ViewerGraphQL", integrationId: graphql.id,
  });
  await ensureRoute(ctx, api.id, "GET /site/{proxy+}", { authorizationType: "NONE", operationName: "SitePassthrough", integrationId: site.id });
  await ensureRoute(ctx, api.id, "$default", { authorizationType: "NONE", operationName: "Fallback", integrationId: graphql.id });

  const first = await ensureDeployment(ctx, api.id, "Initial edge: GraphQL, viewer (SSO) and site pass-through");
  state.http.deployments = [first];
}

export async function seedWebSocketApi(ctx, state) {
  const { db, actor, projectId, log } = ctx;
  log.section(`WebSocket API · ${WS_API_NAME}`);
  const api = await ensureApi(ctx, WS_API_NAME, {
    protocol: "WEBSOCKET",
    description: "Live lookups over a single socket: send {\"action\":\"graphql\",\"query\":\"…\"} and get AniList's answer pushed back on the same connection; {\"action\":\"ping\"} for keep-alive.",
    routeSelectionExpression: "$request.body.action",
    tags: { team: "anime-platform", upstream: "anilist", protocol: "websocket" },
  });
  state.ws = { apiId: api.id, publicId: api.publicId, name: api.name };

  const models = await db.listModels({ projectId, apiId: api.id });
  if (!models.some((row) => row.name === "LiveQuery")) {
    await createModel(db, actor, {
      projectId, apiId: api.id,
      input: {
        name: "LiveQuery", contentType: "application/json", description: "A GraphQL message sent over the socket.",
        schema: {
          $schema: "http://json-schema.org/draft-04/schema#", type: "object",
          properties: { action: { type: "string", enum: ["graphql"] }, query: { type: "string", minLength: 3 }, variables: { type: "object" } },
          required: ["action", "query"],
        },
      },
    });
    log.item("+ model LiveQuery");
  }

  const connect = await ensureIntegration(ctx, api.id, "Connect", {
    type: "MOCK", description: "Accept the socket", requestTemplates: { "$default": "{\"statusCode\": 200}" },
  });
  const disconnect = await ensureIntegration(ctx, api.id, "Disconnect", {
    type: "MOCK", description: "Clean up on disconnect", requestTemplates: { "$default": "{\"statusCode\": 200}" },
  });
  const help = await ensureIntegration(ctx, api.id, "Help", {
    type: "MOCK",
    description: "Explains the protocol for unknown actions",
    requestTemplates: { "$default": "{\"statusCode\": 200, \"body\": {\"message\": \"Send {\\\"action\\\":\\\"graphql\\\",\\\"query\\\":\\\"{ Media(id: 21) { title { romaji } } }\\\"}\"}}" },
  });
  const pong = await ensureIntegration(ctx, api.id, "Ping", {
    type: "MOCK", description: "Keep-alive", requestTemplates: { "$default": "{\"statusCode\": 200, \"body\": {\"type\": \"pong\"}}" },
  });
  const live = await ensureIntegration(ctx, api.id, "LiveGraphQL", {
    type: "HTTP_PROXY", integrationMethod: "POST", uri: ANILIST_URL, timeoutMs: 15000,
    description: "Forwards the socket message to AniList GraphQL",
  });

  await ensureRoute(ctx, api.id, "$connect", { authorizationType: "NONE", apiKeyRequired: true, operationName: "Connect", integrationId: connect.id });
  await ensureRoute(ctx, api.id, "$disconnect", { authorizationType: "NONE", operationName: "Disconnect", integrationId: disconnect.id });
  const fallback = await ensureRoute(ctx, api.id, "$default", {
    authorizationType: "NONE", operationName: "Help", integrationId: help.id, routeResponseSelectionExpression: "$default",
  });
  const ping = await ensureRoute(ctx, api.id, "ping", {
    authorizationType: "NONE", operationName: "Ping", integrationId: pong.id, routeResponseSelectionExpression: "$default",
  });
  const graphql = await ensureRoute(ctx, api.id, "graphql", {
    authorizationType: "NONE", operationName: "LiveGraphQL", integrationId: live.id,
    requestModels: { "$default": "LiveQuery" }, modelSelectionExpression: "$default",
    routeResponseSelectionExpression: "$default",
  });
  for (const route of [fallback, ping, graphql]) {
    const responses = await db.listRouteResponses?.({ routeId: route.id }) ?? [];
    if (responses.length > 0) continue;
    await createRouteResponse(db, actor, { projectId, apiId: api.id, routeId: route.id, routeResponseKey: "$default" });
  }
  log.item("= two-way route responses on $default, ping, graphql");

  const first = await ensureDeployment(ctx, api.id, "Live lookups: graphql + ping over one socket");
  state.ws.deployments = [first];
}
