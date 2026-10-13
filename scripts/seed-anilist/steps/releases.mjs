// Stages, canary, stage cache, throttling, logging/tracing, agent tools and
// API documentation. Stage pointers are only ever set at creation: moving an
// existing stage's deployment is guarded by auth.uid() (stage_promote_guard),
// which the service-role seed does not have — promoting the canary is left
// as a live demo step in the UI.

import { createStage, listStages } from "../../../lib/control/stages.mjs";
import { putCanary } from "../../../lib/control/canary.mjs";
import { putStageCache } from "../../../lib/control/stage-cache.mjs";
import { updateStageThrottle } from "../../../lib/control/usage-plans.mjs";
import { updateStageObservability } from "../../../lib/control/stage-observability.mjs";
import { putAgentTools } from "../../../lib/control/agent-tools.mjs";
import {
  createDocumentationPart, createDocumentationVersion, listDocumentationParts, listDocumentationVersions,
  setStageDocumentationVersion,
} from "../../../lib/control/documentation.mjs";
import { ENDPOINTS } from "../endpoints.mjs";
import { items } from "../context.mjs";

const ACCESS_LOG_FORMAT = "$context.requestId $context.identity.sourceIp $context.httpMethod $context.resourcePath $context.status $context.responseLatency $context.identity.apiKeyId";

async function ensureStage(ctx, apiId, input) {
  const stages = items(await listStages(ctx.db, ctx.actor, { projectId: ctx.projectId, apiId }));
  const existing = stages.find((row) => row.name === input.name);
  if (existing) {
    ctx.log.skip(`stage ${input.name}`);
    return existing;
  }
  await createStage(ctx.db, ctx.actor, { projectId: ctx.projectId, apiId, input });
  ctx.log.item(`+ stage ${input.name}`);
  return input;
}

export async function seedReleases(ctx, state) {
  const { db, actor, projectId, log } = ctx;
  const rest = state.rest;
  const [v10, v11, v12, v13] = rest.deployments;
  log.section("Stages · AniList Explorer");

  await ensureStage(ctx, rest.apiId, {
    name: "dev", deploymentId: v13.id,
    description: "Feature work. Auto-promoted from main; verbose logs and data tracing.",
    variables: { env: "dev", defaultPerPage: "3", anilistHost: "graphql.anilist.co" },
    tags: { env: "dev" },
  });
  await ensureStage(ctx, rest.apiId, {
    name: "staging", deploymentId: v13.id,
    description: "Release candidate soak. Backend mTLS with the staging client certificate.",
    variables: { env: "staging", defaultPerPage: "5", anilistHost: "graphql.anilist.co" },
    clientCertificateId: state.clientCertificateId,
    tags: { env: "staging" },
  });
  await ensureStage(ctx, rest.apiId, {
    name: "prod", deploymentId: v12.id,
    description: "Public traffic for the AniList Developer Hub. v1.3 is on a 10% canary.",
    variables: { env: "prod", defaultPerPage: "10", anilistHost: "graphql.anilist.co" },
    tags: { env: "prod", "cost-center": "anime-platform" },
  });
  void v10; void v11;

  await putCanary(db, actor, {
    projectId, apiId: rest.apiId, stageName: "prod",
    input: { deploymentId: v13.id, percentTraffic: 10, stageVariableOverrides: { env: "prod-canary" }, useStageCache: false },
  });
  log.item("= prod canary: v1.3 at 10% (stage variable env=prod-canary)");

  await putStageCache(db, actor, {
    projectId, apiId: rest.apiId, stageName: "prod",
    input: {
      enabled: true, size: 0.5, defaultTtl: 300, encrypted: true,
      requireAuthorizationForCacheControl: true, unauthorizedStrategy: "SUCCEED_WITH_RESPONSE_HEADER",
    },
  });
  log.item("= prod cache: 0.5 GB, 300 s TTL, encrypted — shields AniList's 30 req/min limit");

  const observability = {
    prod: { loggingLevel: "INFO", dataTraceEnabled: false, tracingEnabled: true },
    staging: { loggingLevel: "ERROR", dataTraceEnabled: true, tracingEnabled: true },
    dev: { loggingLevel: "INFO", dataTraceEnabled: true, tracingEnabled: false },
  };
  for (const [stageName, settings] of Object.entries(observability)) {
    await updateStageObservability(db, actor, {
      projectId, apiId: rest.apiId, stageName,
      input: { ...settings, accessLog: { enabled: true, format: ACCESS_LOG_FORMAT, destinations: ["pods"] } },
    });
  }
  log.item("= access logs on all stages; INFO/tracing on prod, data trace on dev + staging");

  const throttles = {
    prod: { defaultThrottle: { rateLimit: 25, burstLimit: 50 }, methodThrottles: { "/anime/search/GET": { rateLimit: 10, burstLimit: 20 }, "/graphql/POST": { rateLimit: 5, burstLimit: 10 } } },
    staging: { defaultThrottle: { rateLimit: 10, burstLimit: 20 }, methodThrottles: {} },
    dev: { defaultThrottle: { rateLimit: 5, burstLimit: 10 }, methodThrottles: {} },
  };
  for (const [stageName, throttle] of Object.entries(throttles)) {
    await updateStageThrottle(db, actor, { projectId, apiId: rest.apiId, stageName, ...throttle });
  }
  log.item("= stage throttles: prod 25 rps (search 10, graphql 5), staging 10, dev 5");

  await putAgentTools(db, actor, {
    projectId, apiId: rest.apiId, stageName: "prod",
    agentTools: {
      enabled: true,
      allowOperations: ["GetAnime", "SearchAnime", "TrendingAnime", "SeasonalAnime", "AnimeCharacters", "AnimeRecommendations", "GetManga", "GetCharacter"],
      auth: "passthrough",
    },
  });
  log.item("= agent tools (MCP) on prod: 8 read-only operations");

  await seedDocumentation(ctx, state);

  log.section("Stages · AniList GraphQL Edge");
  await ensureStage(ctx, state.http.apiId, {
    name: "$default", deploymentId: state.http.deployments[0].id, autoDeploy: true,
    description: "Auto-deploys every draft change.",
    variables: { env: "prod" },
  });
  await updateStageThrottle(db, actor, {
    projectId, apiId: state.http.apiId, stageName: "$default",
    defaultThrottle: { rateLimit: 20, burstLimit: 40 },
    methodThrottles: { "POST /graphql": { rateLimit: 10, burstLimit: 20 } },
  });
  await updateStageObservability(db, actor, {
    projectId, apiId: state.http.apiId, stageName: "$default",
    input: { accessLog: { enabled: true, format: ACCESS_LOG_FORMAT.replace(" $context.identity.apiKeyId", ""), destinations: ["pods"] } },
  });
  log.item("= $default: auto-deploy, 20 rps, access logs");

  log.section("Stages · AniList Live");
  await ensureStage(ctx, state.ws.apiId, {
    name: "production", deploymentId: state.ws.deployments[0].id,
    description: "Live socket endpoint.",
    variables: { env: "prod" },
  });
  await updateStageThrottle(db, actor, {
    projectId, apiId: state.ws.apiId, stageName: "production",
    defaultThrottle: { rateLimit: 10, burstLimit: 20 },
    methodThrottles: { graphql: { rateLimit: 2, burstLimit: 5 } },
  });
  await updateStageObservability(db, actor, {
    projectId, apiId: state.ws.apiId, stageName: "production",
    input: { loggingLevel: "ERROR", dataTraceEnabled: false },
  });
  log.item("= production: 10 msg/s (graphql 2/s), error logging");
}

async function seedDocumentation(ctx, state) {
  const { db, actor, projectId, log } = ctx;
  const apiId = state.rest.apiId;
  const parts = items(await listDocumentationParts(db, actor, { projectId, apiId }));
  const has = (location) => parts.some((part) => {
    const loc = part.location ?? {};
    return loc.type === location.type && (loc.path ?? "/") === (location.path ?? "/") && (loc.method ?? "*") === (location.method ?? "*")
      && (loc.name ?? null) === (location.name ?? null) && (loc.statusCode ?? "*") === (location.statusCode ?? "*");
  });
  const wanted = [
    {
      location: { type: "API" },
      properties: {
        info: {
          title: "AniList Explorer",
          description: "REST access to the AniList catalog — anime, manga, characters, staff, studios and the airing schedule — served through Geiger Pods. Send your key in `x-api-key`. Responses are cached for 5 minutes at the edge.",
          contact: { name: "Anime Platform team", email: "anime-platform@geiger.studio" },
          termsOfService: "https://anilist.co/terms",
        },
      },
    },
    { location: { type: "QUERY_PARAMETER", path: "/anime/search", method: "GET", name: "q" }, properties: { description: "Title to search for (romaji, English or native).", example: "Frieren" } },
    { location: { type: "QUERY_PARAMETER", path: "/anime/search", method: "GET", name: "genre" }, properties: { description: "Optional AniList genre filter, e.g. Fantasy." } },
    { location: { type: "PATH_PARAMETER", path: "/anime/{id}", method: "*", name: "id" }, properties: { description: "AniList media id (the number in anilist.co/anime/<id>).", example: 154587 } },
    { location: { type: "PATH_PARAMETER", path: "/anime/seasonal/{year}/{season}", method: "*", name: "season" }, properties: { description: "WINTER, SPRING, SUMMER or FALL (case-insensitive)." } },
    { location: { type: "RESPONSE", path: "/anime/{id}", method: "GET", statusCode: "404" }, properties: { description: "No anime with that id. Body follows the Error model." } },
    { location: { type: "RESPONSE", path: "/", method: "*", statusCode: "429" }, properties: { description: "Throttled by your plan, or AniList's upstream limit was hit. Back off and retry." } },
    { location: { type: "MODEL", name: "Anime" }, properties: { description: "Flattened AniList Media object." } },
    { location: { type: "AUTHORIZER", name: "Geiger Suite SSO" }, properties: { description: "Send the access token from your Geiger session as `Authorization: Bearer <token>`." } },
    ...ENDPOINTS.map((endpoint) => ({
      location: { type: "METHOD", path: endpoint.path, method: "GET" },
      properties: { summary: endpoint.summary, tags: [endpoint.path.split("/")[1]] },
    })),
    { location: { type: "METHOD", path: "/graphql", method: "POST" }, properties: { summary: "Run any AniList GraphQL query (validated, metered).", tags: ["graphql"] } },
    { location: { type: "METHOD", path: "/me", method: "GET" }, properties: { summary: "Who am I? Echoes your verified Geiger identity.", tags: ["account"] } },
  ];
  let added = 0;
  for (const part of wanted) {
    if (has(part.location)) continue;
    await createDocumentationPart(db, actor, { projectId, apiId, location: part.location, properties: part.properties });
    added += 1;
  }
  log.item(`= documentation: ${added} part(s) added (${wanted.length} total)`);
  const versions = items(await listDocumentationVersions(db, actor, { projectId, apiId }));
  for (const [version, description] of [["1.1", "Manga, people and studios"], ["1.2", "GraphQL passthrough, SSO and schedule"]]) {
    if (versions.some((row) => row.version === version)) continue;
    await createDocumentationVersion(db, actor, { projectId, apiId, version, description });
    log.item(`+ documentation version ${version}`);
  }
  await setStageDocumentationVersion(db, actor, { projectId, apiId, stageName: "prod", version: "1.2" });
  await setStageDocumentationVersion(db, actor, { projectId, apiId, stageName: "staging", version: "1.2" });
}
