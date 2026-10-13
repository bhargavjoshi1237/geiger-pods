// Monitoring config (notification channels, alarms, log export sinks,
// trace sampling), the developer portal, and admin features (access tokens,
// event webhooks, stacks-as-code, tags).

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createAlarm, createChannel, listAlarms, listChannels } from "../../../lib/control/alarms.mjs";
import { createSink, listSinks } from "../../../lib/control/log-sinks.mjs";
import { createSamplingRule, listSamplingRules } from "../../../lib/control/sampling-rules.mjs";
import {
  createPortal, createPortalProduct, createProductEndpoint, createProductPage, linkProductToPortal, publishPortal,
} from "../../../lib/control/portals.mjs";
import { createToken, listTokens } from "../../../lib/control/access-tokens.mjs";
import { createSubscription, listSubscriptions } from "../../../lib/control/event-subscriptions.mjs";
import { applyStack } from "../../../lib/control/stacks.mjs";
import { putTags } from "../../../lib/control/tags.mjs";
import { body, items, ROOT } from "../context.mjs";

const TOKENS_FILE = join(ROOT, "scripts", "seed-anilist", "output", "access-tokens.json");

export async function seedMonitoring(ctx, state) {
  const { db, actor, projectId, log } = ctx;
  log.section("Notification channels & alarms");
  const channels = items(await listChannels(db, actor, { projectId }));
  const ensureChannel = async (name, type, config) => {
    const found = channels.find((row) => row.name === name);
    if (found) return found;
    const created = body(await createChannel(db, actor, { projectId, input: { name, type, config } }, { mailerAvailable: true }));
    log.item(`+ channel ${name} (${type})`);
    return created;
  };
  const slack = await ensureChannel("#anime-platform-alerts", "slack_webhook", { url: "https://hooks.slack.com/services/T0GEIGER/B0ANIMEPODS/demo-placeholder" });
  const pager = await ensureChannel("On-call (PagerDuty)", "webhook", { url: "https://events.pagerduty.com/integration/geiger-notes-pods/enqueue" });
  const email = await ensureChannel("Platform digest", "email", { to: "anime-platform@geiger.studio" });

  const rest = { ApiId: state.rest.publicId, Stage: "prod" };
  const alarmSpecs = [
    { name: "Explorer prod 5XX", description: "Server errors on the public REST pod (usually AniList outages).", metric: "5XXError", dimensions: rest, statistic: "Sum", periodSec: 300, evaluationPeriods: 3, datapointsToAlarm: 2, comparison: ">", threshold: 20, treatMissingData: "notBreaching", actions: { ok: [slack.id], alarm: [slack.id, pager.id], insufficientData: [] } },
    { name: "Explorer prod p90 latency", description: "Edge cache should keep p90 well under a second.", metric: "Latency", dimensions: rest, statistic: "p90", periodSec: 300, evaluationPeriods: 5, datapointsToAlarm: 3, comparison: ">", threshold: 1200, treatMissingData: "notBreaching", actions: { ok: [], alarm: [slack.id], insufficientData: [] } },
    { name: "Explorer throttling", description: "Consumers hitting stage or plan throttles.", metric: "ThrottleCount", dimensions: rest, statistic: "Sum", periodSec: 300, evaluationPeriods: 3, datapointsToAlarm: 3, comparison: ">", threshold: 150, treatMissingData: "notBreaching", actions: { ok: [], alarm: [slack.id], insufficientData: [] } },
    { name: "Cache miss surge", description: "Misses spike after a deploy or cache flush — AniList's 30 req/min limit is close.", metric: "CacheMissCount", dimensions: rest, statistic: "Sum", periodSec: 3600, evaluationPeriods: 2, datapointsToAlarm: 2, comparison: ">", threshold: 1500, treatMissingData: "missing", actions: { ok: [], alarm: [slack.id, email.id], insufficientData: [] } },
    { name: "Quota rejections", description: "Free-tier keys running out of daily quota (upsell signal).", metric: "QuotaRejectCount", dimensions: rest, statistic: "Sum", periodSec: 3600, evaluationPeriods: 1, datapointsToAlarm: 1, comparison: ">", threshold: 50, treatMissingData: "notBreaching", actions: { ok: [], alarm: [email.id], insufficientData: [] } },
    { name: "GraphQL Edge 5xx", description: "Errors on the first-party GraphQL edge.", metric: "5xx", dimensions: { ApiId: state.http.publicId, Stage: "$default" }, statistic: "Sum", periodSec: 300, evaluationPeriods: 3, datapointsToAlarm: 2, comparison: ">", threshold: 10, treatMissingData: "notBreaching", actions: { ok: [], alarm: [slack.id], insufficientData: [] } },
    { name: "Live socket execution errors", description: "Failed GraphQL lookups over the WebSocket.", metric: "ExecutionError", dimensions: { ApiId: state.ws.publicId, Stage: "production" }, statistic: "Sum", periodSec: 300, evaluationPeriods: 3, datapointsToAlarm: 2, comparison: ">", threshold: 5, treatMissingData: "notBreaching", actions: { ok: [], alarm: [slack.id], insufficientData: [] } },
  ];
  const alarms = items(await listAlarms(db, actor, { projectId }));
  state.alarms = {};
  for (const spec of alarmSpecs) {
    let alarm = alarms.find((row) => row.name === spec.name);
    if (!alarm) {
      alarm = body(await createAlarm(db, actor, { projectId, input: { ...spec, enabled: true } }));
      log.item(`+ alarm ${spec.name}`);
    }
    state.alarms[spec.name] = alarm.id;
  }

  log.section("Log exports & sampling");
  const sinks = items(await listSinks(db, actor, { projectId }));
  const sinkSpecs = [
    { name: "datadog-eu", type: "https", config: { url: "https://http-intake.logs.datadoghq.eu/api/v2/logs", secretRef: `secret:${state.secrets["datadog-api-key"]}`, batchMaxBytes: 1048576 }, status: "active" },
    { name: "access-log-archive", type: "s3", config: { bucket: "geiger-notes-pods-logs", prefix: "anilist/access/", region: "ap-south-1", credentialsRef: `secret:${state.secrets["log-archive-s3"]}` }, status: "active" },
    { name: "grafana-otlp", type: "otlp_logs", config: { endpoint: "https://otlp-gateway-prod-ap-south-1.grafana.net/otlp/v1/logs", headersRef: `secret:${state.secrets["grafana-otlp-token"]}` }, status: "error" },
  ];
  for (const spec of sinkSpecs) {
    if (sinks.some((row) => row.name === spec.name)) continue;
    await createSink(db, actor, { projectId, input: spec });
    log.item(`+ sink ${spec.name} (${spec.type})`);
  }
  const rules = items(await listSamplingRules(db, actor, { projectId }));
  if (rules.length === 0) {
    await createSamplingRule(db, actor, { projectId, input: { priority: 1, reservoirPerSec: 2, fixedRate: 0.5, match: { apiId: state.rest.publicId, path: "/graphql" } } });
    await createSamplingRule(db, actor, { projectId, input: { priority: 5, reservoirPerSec: 1, fixedRate: 1, match: { apiId: state.rest.publicId, stage: "staging" } } });
    await createSamplingRule(db, actor, { projectId, input: { priority: 100, reservoirPerSec: 1, fixedRate: 0.05, match: {} } });
    log.item("+ trace sampling: /graphql 50%, staging 100%, default 5%");
  }
}

const PAGES = [
  {
    title: "Getting started", slug: "getting-started",
    bodyMarkdown: [
      "# Getting started",
      "",
      "1. Pick a plan and request a key — it arrives in your inbox.",
      "2. Send it in the `x-api-key` header:",
      "",
      "```bash",
      "curl -H \"x-api-key: $ANILIST_EXPLORER_KEY\" https://anime.geiger-notes.dev/v1/anime/154587",
      "```",
      "",
      "3. Responses are plain JSON — no GraphQL needed. Hot lookups are cached for five minutes.",
    ].join("\n"),
  },
  {
    title: "Errors & limits", slug: "errors-and-limits",
    bodyMarkdown: [
      "# Errors & limits",
      "",
      "Every error uses the same envelope: `{\"error\": {\"code\", \"message\", \"requestId\"}}`.",
      "",
      "| Code | Status | Meaning |",
      "| --- | --- | --- |",
      "| `INVALID_API_KEY` | 403 | Missing or unknown key |",
      "| `SLOW_DOWN` | 429 | Your plan's rate limit |",
      "| `QUOTA_EXCEEDED` | 429 | Daily/monthly quota used up |",
      "| `NOT_FOUND` | 404 | AniList has no such entry |",
      "| `UPSTREAM_BUSY` | 429 | AniList is rate limiting the gateway |",
    ].join("\n"),
  },
  {
    title: "Using the GraphQL passthrough", slug: "graphql",
    bodyMarkdown: "# GraphQL passthrough\n\nPartner keys can `POST /graphql` with any AniList query. Bodies are validated (max 8 KB) and metered like REST calls.",
  },
];

export async function seedPortal(ctx, state) {
  const { db, actor, projectId, log } = ctx;
  log.section("Developer portal");
  const portals = await db.listPortals({ projectId });
  let portal = portals.find((row) => row.slug === "anilist-hub");
  if (!portal) {
    portal = body(await createPortal(db, actor, {
      projectId,
      name: "AniList Developer Hub",
      slug: "anilist-hub",
      branding: {
        primaryColor: "#02A9FF", accentColor: "#C063FF", theme: "dark",
        headerLinks: [{ label: "AniList", url: "https://anilist.co" }, { label: "Status", url: "https://status.geiger-notes.dev" }],
        footerMarkdown: "Anime data from [AniList](https://anilist.co) · Served through Geiger Pods",
      },
      access: { mode: "public" },
      analyticsEnabled: true,
    }));
    log.item("+ portal AniList Developer Hub (/portal/anilist-hub)");
  }
  state.portal = { id: portal.id, slug: "anilist-hub" };

  const products = await db.listPortalProducts({ projectId });
  const productSpecs = [
    { key: "free", name: "Explorer Free", description: "Try the catalog: 500 calls a day.", plan: "free", order: 0, endpoints: [["/anime/{id}", "GetAnime"], ["/anime/search", "SearchAnime"], ["/anime/trending", "TrendingAnime"]] },
    { key: "pro", name: "Explorer Pro", description: "Production apps: 50k calls a month, every REST endpoint.", plan: "pro", order: 1, endpoints: [["/anime/{id}", "GetAnime"], ["/anime/search", "SearchAnime"], ["/anime/seasonal/{year}/{season}", "SeasonalAnime"], ["/anime/{id}/characters", "AnimeCharacters"], ["/manga/{id}", "GetManga"], ["/characters/{id}", "GetCharacter"], ["/schedule/airing", "AiringSchedule"]] },
    { key: "partner", name: "Partner Program", description: "GraphQL passthrough, bulk exports and 1M calls a month.", plan: "partner", order: 2, endpoints: [["/graphql", "GraphQLQuery", "POST"], ["/partners/exports", "CreatePartnerExport", "POST"]] },
  ];
  state.products = {};
  for (const spec of productSpecs) {
    let product = products.find((row) => row.name === spec.name);
    if (!product) {
      product = body(await createPortalProduct(db, actor, {
        projectId, name: spec.name, description: spec.description, displayOrder: spec.order, usagePlanId: state.plans[spec.plan].id,
      }));
      await linkProductToPortal(db, actor, { projectId, portalId: portal.id, productId: product.id, order: spec.order });
      for (const [index, page] of PAGES.entries()) {
        if (spec.key === "partner" || page.slug !== "graphql") {
          await createProductPage(db, actor, { projectId, productId: product.id, ...page, order: index });
        }
      }
      for (const [resourcePath, operationName, httpMethod = "GET"] of spec.endpoints) {
        await createProductEndpoint(db, actor, {
          projectId, productId: product.id, apiId: state.rest.apiId, stageName: "prod", resourcePath, httpMethod, operationName, tryItEnabled: true,
        });
      }
      log.item(`+ product ${spec.name} (${spec.endpoints.length} endpoints)`);
    }
    state.products[spec.key] = product.id;
  }
  await publishPortal(db, actor, { projectId, portalId: portal.id });
  log.item("⇪ portal published");
}

export async function seedAdmin(ctx, state) {
  const { db, actor, projectId, log } = ctx;
  log.section("Access tokens");
  const saved = existsSync(TOKENS_FILE) ? JSON.parse(readFileSync(TOKENS_FILE, "utf8")) : {};
  const tokens = items(await listTokens(db, actor, { projectId }));
  const tokenSpecs = [
    { kind: "personal", name: "bhargav · pods CLI (laptop)", scopes: ["*"], expiresAt: new Date(Date.now() + 180 * 86400000).toISOString() },
    { kind: "service", name: "github-actions · deploy anilist-explorer", scopes: ["pods.deployment.create", "pods.stage.write", "pods.stage.promote"] },
    { kind: "service", name: "grafana · metrics reader", scopes: ["pods.logs.view", "pods.usage.view"], expiresAt: new Date(Date.now() + 90 * 86400000).toISOString() },
  ];
  for (const spec of tokenSpecs) {
    if (tokens.some((row) => row.name === spec.name)) continue;
    const created = body(await createToken(db, actor, { projectId, ...spec, userId: spec.kind === "personal" ? actor.userId : null }));
    saved[spec.name] = { token: created.token, id: created.id };
    log.item(`+ ${spec.kind} token "${spec.name}"`);
  }
  writeFileSync(TOKENS_FILE, `${JSON.stringify(saved, null, 2)}\n`);

  log.section("Event webhooks");
  const subs = items(await listSubscriptions(db, actor, { projectId }));
  const subSpecs = [
    { name: "deploys-to-slack-bridge", eventTypes: ["deployment.create", "deployment.canary_deploy", "stage.promote", "stage.canary_promote"], targetUrl: "https://hooks.geiger-notes.dev/pods/deploys" },
    { name: "key-lifecycle-to-crm", eventTypes: ["api_key.create", "api_key.rotate", "api_key.update", "usage_plan.key_add"], targetUrl: "https://crm.geiger-notes.dev/webhooks/pods-keys" },
    { name: "security-audit-feed", eventTypes: ["secret.rotate", "waf_acl.update", "role.grant", "token.create"], targetUrl: "https://siem.geiger-notes.dev/ingest/pods" },
  ];
  for (const spec of subSpecs) {
    if (subs.some((row) => row.name === spec.name)) continue;
    await createSubscription(db, actor, {
      projectId, input: { ...spec, secretRef: `secret:${state.secrets["webhook-signing-secret"]}`, enabled: true },
    });
    log.item(`+ webhook ${spec.name} (${spec.eventTypes.length} events)`);
  }

  log.section("Stacks (config as code)");
  const file = {
    version: 1,
    stack: "anilist-sandbox",
    apis: [{ name: "AniList Sandbox", protocol: "REST", description: "Scratch API for workshop attendees, managed by the anilist-sandbox stack." }],
    secrets: [{ name: "anilist-upstream-tag" }],
  };
  try {
    const applied = body(await applyStack(db, actor, { projectId, stack: "anilist-sandbox", file }));
    log.item(`= stack anilist-sandbox applied (${applied?.changes?.length ?? applied?.applied?.length ?? 0} change(s))`);
  } catch (error) {
    if (error?.status !== 409) throw error;
    log.skip("stack anilist-sandbox");
  }

  log.section("Tags");
  const tagSets = [
    ["stage", `${state.rest.apiId}:prod`, { env: "prod", "cost-center": "anime-platform", oncall: "anime-platform" }],
    ["usage_plan", state.plans.free.id, { tier: "free", "sales-motion": "self-serve" }],
    ["usage_plan", state.plans.partner.id, { tier: "partner", contract: "annual" }],
    ["api_key", state.keys["Demo Presenter"], { purpose: "demo", owner: "devrel" }],
    ["secret", state.secrets["anilist-oauth-client"], { rotation: "90d", owner: "anime-platform" }],
    ["connector", state.connectors.recs, { site: "mumbai-office", owner: "ml-platform" }],
    ["web_acl", state.waf.shield, { compliance: "owasp-top10" }],
    ["portal", state.portal.id, { audience: "external" }],
  ];
  for (const [resourceType, resourceId, tags] of tagSets) {
    try {
      await putTags(db, actor, { projectId, resourceType, resourceId, tags });
    } catch (error) {
      log.item(`  ! tags on ${resourceType}: ${error.message}`);
    }
  }
  log.item(`= tags on ${tagSets.length} resources`);
}
