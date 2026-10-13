// Usage plans, consumer API keys (create, CSV import, rotate, disable) and a
// quota adjustment. Key values are shown once by the service; the seed keeps
// them in output/api-keys.json (git-ignored) so the demo can use them.

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { addKeyToPlan, addPlanStage, createPlan, listPlans, updateUsage } from "../../../lib/control/usage-plans.mjs";
import { createApiKey, importApiKeys, listApiKeys, rotateApiKey, updateApiKey } from "../../../lib/control/api-keys.mjs";
import { MemoryKvStore } from "../../../lib/gateway/state/memory-kv.mjs";
import { body, items, ROOT } from "../context.mjs";

const KEYS_FILE = join(ROOT, "scripts", "seed-anilist", "output", "api-keys.json");

const PLANS = [
  {
    key: "free",
    name: "Genin · Free",
    description: "For hobby projects and hackathons. 500 calls a day, 2 requests per second.",
    throttle: { rateLimit: 2, burstLimit: 5 },
    quota: { limit: 500, period: "DAY" },
    stages: (s) => [[s.rest.apiId, "prod", {}], [s.ws.apiId, "production", {}]],
    tags: { tier: "free" },
  },
  {
    key: "pro",
    name: "Chunin · Pro",
    description: "For production apps. 50k calls a month, 10 rps, search capped at 5 rps.",
    throttle: { rateLimit: 10, burstLimit: 20 },
    quota: { limit: 50000, period: "MONTH" },
    stages: (s) => [[s.rest.apiId, "prod", { "/anime/search/GET": { rateLimit: 5, burstLimit: 10 } }], [s.ws.apiId, "production", {}]],
    tags: { tier: "pro" },
  },
  {
    key: "partner",
    name: "Hokage · Partner",
    description: "Contracted partners: 1M calls a month, 25 rps, GraphQL passthrough and bulk exports.",
    throttle: { rateLimit: 25, burstLimit: 50 },
    quota: { limit: 1000000, period: "MONTH", offset: 0 },
    stages: (s) => [[s.rest.apiId, "prod", { "/graphql/POST": { rateLimit: 10, burstLimit: 20 } }]],
    tags: { tier: "partner" },
  },
  {
    key: "qa",
    name: "Internal QA",
    description: "Smoke tests and load checks against dev and staging. No quota.",
    throttle: { rateLimit: 10, burstLimit: 20 },
    quota: null,
    stages: (s) => [[s.rest.apiId, "staging", {}], [s.rest.apiId, "dev", {}]],
    tags: { tier: "internal" },
  },
];

const KEYS = [
  { name: "Otaku Tracker iOS", plan: "pro", customerId: "cust_otaku_tracker", description: "Watch-list app (iOS + iPadOS).", tags: { platform: "ios" } },
  { name: "Seasonal Chart Web", plan: "pro", customerId: "cust_seasonal_chart", description: "seasonal-chart.app — rotated after a leaked build.", tags: { platform: "web" }, rotate: true },
  { name: "Weeb Discord Bot", plan: "free", customerId: "cust_weeb_bot", description: "Community Discord bot (/anime, /manga commands).", tags: { platform: "discord" }, topUp: 1000 },
  { name: "Crunchy Recs ML", plan: "partner", customerId: "cust_crunchy_recs", description: "Nightly recommendation model refresh.", tags: { platform: "batch" } },
  { name: "Hackathon Team 7", plan: "free", customerId: "cust_hackathon_7", description: "Geiger Hack Week 2026 — event over, key disabled.", tags: { platform: "web" }, disable: true },
  { name: "QA Smoke Tests", plan: "qa", customerId: "geiger_internal", description: "CI smoke tests against dev and staging.", tags: { platform: "ci" } },
  { name: "Demo Presenter", plan: "partner", customerId: "geiger_internal", description: "Key used for live product demos of this showcase.", tags: { platform: "demo" } },
];

export async function seedUsage(ctx, state) {
  const { db, actor, projectId, log } = ctx;
  log.section("Usage plans");
  const existingPlans = items(await listPlans(db, actor, { projectId }));
  state.plans = {};
  for (const spec of PLANS) {
    let plan = existingPlans.find((row) => row.name === spec.name);
    if (plan) {
      log.skip(spec.name);
    } else {
      plan = body(await createPlan(db, actor, {
        projectId, name: spec.name, description: spec.description, throttle: spec.throttle,
        ...(spec.quota ? { quota: spec.quota } : {}), tags: spec.tags,
      }));
      log.item(`+ ${spec.name}`);
      for (const [apiId, stage, methodThrottles] of spec.stages(state)) {
        await addPlanStage(db, actor, { projectId, planId: plan.id, apiId, stage, methodThrottles });
      }
    }
    state.plans[spec.key] = { id: plan.id, publicId: plan.publicId };
  }

  log.section("API keys");
  const saved = existsSync(KEYS_FILE) ? JSON.parse(readFileSync(KEYS_FILE, "utf8")) : {};
  let keys = items(await listApiKeys(db, actor, { projectId }));
  const kv = new MemoryKvStore({});
  state.keys = {};
  for (const spec of KEYS) {
    let key = keys.find((row) => row.name === spec.name);
    if (key) {
      log.skip(spec.name);
    } else {
      key = body(await createApiKey(db, actor, {
        projectId, name: spec.name, description: spec.description, customerId: spec.customerId, tags: spec.tags, enabled: true,
      }));
      saved[spec.name] = { value: key.value, plan: spec.plan, id: key.id };
      await addKeyToPlan(db, actor, { projectId, planId: state.plans[spec.plan].id, keyId: key.id });
      log.item(`+ ${spec.name} → ${PLANS.find((p) => p.key === spec.plan).name}`);
      if (spec.rotate) {
        const rotated = body(await rotateApiKey(db, actor, { projectId, keyId: key.id }));
        saved[rotated.name] = { value: rotated.value, plan: spec.plan, id: rotated.id };
        await updateApiKey(db, actor, { projectId, keyId: key.id, patch: { enabled: false, description: `${spec.description} Superseded by the rotated key.` } });
        log.item(`  ↻ rotated → "${rotated.name}", old key disabled`);
      }
      if (spec.disable) {
        await updateApiKey(db, actor, { projectId, keyId: key.id, patch: { enabled: false } });
        log.item("  ⨯ disabled");
      }
      if (spec.topUp) {
        await updateUsage(db, actor, { projectId, planId: state.plans[spec.plan].id, keyId: key.id, op: "extend", value: spec.topUp }, { kv });
        log.item(`  + quota extended by ${spec.topUp} for today`);
      }
    }
    state.keys[spec.name] = key.id;
  }

  if (!keys.some((row) => row.name === "Campus Anime Club")) {
    const csv = [
      "Name,Key,Description,Enabled,UsagePlanIds",
      `Campus Anime Club,,Imported from the university partner sheet,true,${state.plans.free.publicId}`,
      `Manga Reader Beta,,Imported from the beta programme sheet,true,${state.plans.pro.publicId}`,
    ].join("\n");
    const result = body(await importApiKeys(db, actor, { projectId, csv }));
    log.item(`+ imported ${result.ids?.length ?? 0} keys from CSV${result.warnings?.length ? ` (${result.warnings.length} warnings)` : ""}`);
  }
  keys = items(await listApiKeys(db, actor, { projectId }));
  log.item(`= ${keys.length} keys total`);
  writeFileSync(KEYS_FILE, `${JSON.stringify(saved, null, 2)}\n`);
}
