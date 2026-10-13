#!/usr/bin/env node
// Read-only check of the seeded showcase through the same service functions
// the management API routes call (i.e. what each UI screen loads).
//
//   node scripts/seed-anilist/verify.mjs

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSeedContext, items, body, ROOT } from "./context.mjs";
import { listApis } from "../../lib/control/apis.mjs";
import { listStages, listStageHistory } from "../../lib/control/stages.mjs";
import { listDeployments, diffDeployments } from "../../lib/control/deployments.mjs";
import { listResources } from "../../lib/control/rest-resources.mjs";
import { listRoutes } from "../../lib/control/http-routes.mjs";
import { listPlans } from "../../lib/control/usage-plans.mjs";
import { listApiKeys } from "../../lib/control/api-keys.mjs";
import { listSecrets } from "../../lib/control/secrets.mjs";
import { listWebAcls, listIpSets, listRegexSets } from "../../lib/control/waf.mjs";
import { listSigningCredentials } from "../../lib/control/signing-credentials.mjs";
import { listDomains, listTrustStores, listMappings } from "../../lib/control/domains.mjs";
import { listConnectors } from "../../lib/control/connectors.mjs";
import { getDashboard } from "../../lib/control/metrics.mjs";
import { listAlarms, listChannels } from "../../lib/control/alarms.mjs";
import { listSinks } from "../../lib/control/log-sinks.mjs";
import { listRoleGrants } from "../../lib/control/role-grants.mjs";
import { listTokens } from "../../lib/control/access-tokens.mjs";
import { listSubscriptions } from "../../lib/control/event-subscriptions.mjs";
import { listAuditEvents } from "../../lib/control/audit.mjs";
import { getCanary } from "../../lib/control/canary.mjs";
import { getStageCache } from "../../lib/control/stage-cache.mjs";
import { getAgentTools } from "../../lib/control/agent-tools.mjs";
import { listDocumentationParts } from "../../lib/control/documentation.mjs";
import { getSettings } from "../../lib/control/settings.mjs";

const ctx = createSeedContext();
const { db, actor, projectId } = ctx;
const state = JSON.parse(readFileSync(join(ROOT, "scripts", "seed-anilist", "output", "state.json"), "utf8"));
let failures = 0;

async function check(label, fn, describe) {
  try {
    const value = await fn();
    console.log(`  ✓ ${label.padEnd(30)} ${describe(value)}`);
  } catch (error) {
    failures += 1;
    console.log(`  ✗ ${label.padEnd(30)} ${error?.status ?? ""} ${error?.message ?? error}`);
  }
}

const rest = { projectId, apiId: state.rest.apiId };
console.log("Screens (service read paths):");
await check("APIs", () => listApis(db, actor, { projectId }), (r) => items(r).map((a) => `${a.name} [${a.protocol}]`).join(", "));
await check("REST resources", () => listResources(db, actor, { ...rest, limit: 100 }), (r) => `${items(r).length} resources`);
await check("HTTP routes", () => listRoutes(db, actor, { projectId, apiId: state.http.apiId }), (r) => items(r).map((x) => x.routeKey).join(", "));
await check("WS routes", () => listRoutes(db, actor, { projectId, apiId: state.ws.apiId }), (r) => items(r).map((x) => x.routeKey).join(", "));
await check("Stages", () => listStages(db, actor, rest), (r) => items(r).map((s) => `${s.name}→${s.deploymentId?.slice(0, 8) ?? "?"}`).join(", "));
await check("Stage history (prod)", () => listStageHistory(db, actor, { ...rest, stageName: "prod" }), (r) => `${items(r).length} entries`);
await check("Deployments", () => listDeployments(db, actor, rest), (r) => `${items(r).length} deployments`);
await check("Deployment diff v1.2→v1.3", () => diffDeployments(db, actor, { ...rest, deploymentIdA: state.rest.deployments[2].id, deploymentIdB: state.rest.deployments[3].id }), (r) => JSON.stringify(body(r)).slice(0, 90));
await check("Canary (prod)", () => getCanary(db, actor, { ...rest, stageName: "prod" }), (r) => JSON.stringify(body(r)).slice(0, 90));
await check("Stage cache (prod)", () => getStageCache(db, actor, { ...rest, stageName: "prod" }), (r) => JSON.stringify(body(r)).slice(0, 90));
await check("Agent tools (prod)", () => getAgentTools(db, actor, { ...rest, stageName: "prod" }), (r) => JSON.stringify(body(r)).slice(0, 90));
await check("Documentation parts", () => listDocumentationParts(db, actor, rest), (r) => `${items(r).length} parts`);
await check("Usage plans", () => listPlans(db, actor, { projectId }), (r) => items(r).map((p) => p.name).join(", "));
await check("API keys", () => listApiKeys(db, actor, { projectId }), (r) => `${items(r).length} keys (${items(r).filter((k) => !k.enabled).length} disabled)`);
await check("Secrets", () => listSecrets(db, actor, { projectId }), (r) => `${items(r).length} secrets`);
await check("WAF web ACLs", () => listWebAcls(db, actor, { projectId }), (r) => items(r).map((a) => a.name).join(", "));
await check("WAF IP / regex sets", async () => [items(await listIpSets(db, actor, { projectId })), items(await listRegexSets(db, actor, { projectId }))], ([a, b]) => `${a.length} IP sets, ${b.length} regex sets`);
await check("Signing credentials", () => listSigningCredentials(db, actor, { projectId }), (r) => `${items(r).length} credentials`);
await check("Custom domains", () => listDomains(db, actor, { projectId }), (r) => items(r).map((d) => `${d.domainName} (${d.status})`).join(", "));
await check("API mappings (anime.)", () => listMappings(db, actor, { projectId, domainId: state.domains.anime }), (r) => `${items(r).length} mappings`);
await check("Trust stores", () => listTrustStores(db, actor, { projectId }), (r) => `${items(r).length} trust stores`);
await check("Connectors", () => listConnectors(db, actor, { projectId }), (r) => items(r).map((c) => `${c.name} (${c.status})`).join(", "));
await check("Dashboard (14 days)", () => getDashboard(db, actor, { projectId, days: 14 }), (r) => {
  const d = body(r);
  return `requests ${d.current?.requests ?? d.totals?.requests ?? "?"}, 4xx ${d.current?.errors4xx ?? "?"}, 5xx ${d.current?.errors5xx ?? "?"}, p90 ${d.current?.p90LatencyMs ?? "?"} ms, days ${d.daily?.length ?? "?"}`;
});
await check("Alarms", () => listAlarms(db, actor, { projectId }), (r) => items(r).map((a) => `${a.name}=${a.state}`).join(", "));
await check("Alarm channels", () => listChannels(db, actor, { projectId }), (r) => `${items(r).length} channels`);
await check("Log export sinks", () => listSinks(db, actor, { projectId }), (r) => items(r).map((s) => `${s.name}(${s.status})`).join(", "));
await check("Team & access", () => listRoleGrants(db, actor, { projectId }), (r) => `${items(r).length} grants`);
await check("Access tokens", () => listTokens(db, actor, { projectId }), (r) => `${items(r).length} tokens`);
await check("Event webhooks", () => listSubscriptions(db, actor, { projectId }), (r) => `${items(r).length} subscriptions`);
await check("Audit log", () => listAuditEvents(db, actor, { projectId, limit: 5 }), (r) => `${items(r).length} latest shown`);
await check("Settings", () => getSettings(db, actor, { projectId }), (r) => JSON.stringify(body(r)).slice(0, 80));

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll screen reads succeeded.");
process.exitCode = failures ? 1 : 0;
