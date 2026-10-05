import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const screens = await import("../../lib/workspace/screens.mjs");
const tabs = await import("../../components/internal/screens/apis/tabs.js");
const authUi = await import("../../lib/workspace/auth-ui.mjs");
const resourcePolicies = await import("../../lib/control/resource-policies.mjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
async function source(relative) {
  return readFile(path.join(ROOT, relative), "utf8");
}

test("C1: workspace routes map every delivered screen (S04–S10, S14, S07 credentials)", () => {
  assert.deepEqual(screens.resolveScreen(["usage-plans"]), { section: "usage", screen: "usagePlans", params: {} });
  assert.deepEqual(screens.resolveScreen(["api-keys"]), { section: "usage", screen: "apiKeys", params: {} });
  // Backwards-compatible alias keeps its S02 contract.
  assert.deepEqual(screens.resolveScreen(["usage"]), { section: "usage", screen: "usagePlans", params: {} });
  assert.deepEqual(screens.resolveScreen(["monitoring", "logs"]), { section: "monitoring", screen: "logs", params: {} });
  assert.deepEqual(screens.resolveScreen(["monitoring", "alarms"]), { section: "monitoring", screen: "alarms", params: {} });
  assert.deepEqual(screens.resolveScreen(["access", "credentials"]), { section: "settings", screen: "credentials", params: {} });
  assert.deepEqual(screens.resolveScreen(["settings", "tokens"]), { section: "settings", screen: "tokens", params: {} });
  assert.deepEqual(screens.resolveScreen(["settings", "exports"]), { section: "settings", screen: "exports", params: {} });
  assert.deepEqual(screens.resolveScreen(["settings", "stacks"]), { section: "settings", screen: "stacks", params: {} });
  assert.deepEqual(screens.resolveScreen(["audit"]), { section: "audit", screen: "auditLog", params: {} });
  // Pre-existing routes are untouched.
  assert.deepEqual(screens.resolveScreen(["apis", "abc123", "authorizers"]), {
    section: "apis", screen: "apiDetail", params: { apiId: "abc123", tab: "authorizers" },
  });
  assert.equal(screens.resolveScreen(["monitoring", "nope"]), null);
  assert.equal(screens.resolveScreen(["settings", "billing"]), null);
});

test("C1: every API detail tab is wired except S13 docs", () => {
  const unwired = tabs.API_TABS.filter((entry) => !entry.wired);
  assert.deepEqual(unwired.map((entry) => entry.slug), ["docs"]);
  assert.equal(tabs.API_TABS.find((entry) => entry.slug === "docs")?.owner, "S13");
  for (const slug of ["integrations", "authorizers", "models", "cors", "gateway-responses", "deployments", "stages", "monitoring"]) {
    assert.equal(tabs.API_TABS.find((entry) => entry.slug === slug)?.wired, true, `${slug} must be wired`);
  }
  assert.ok(tabs.tabsForProtocol("REST").some((entry) => entry.slug === "authorizers"));
  assert.ok(tabs.tabsForProtocol("HTTP").some((entry) => entry.slug === "cors"));
});

test("C1: registry mounts every delivered screen", async () => {
  const registry = await source("components/internal/screens/registry.jsx");
  for (const key of ["usagePlans", "apiKeys", "monitoring", "logs", "alarms", "exports", "auditLog", "tokens", "stacks", "credentials"]) {
    assert.match(registry, new RegExp(`\\b${key}\\b`), `registry must mount ${key}`);
  }
  for (const name of ["UsagePlansScreen", "ApiKeysScreen", "MonitoringOverview", "LogsScreen", "AlarmsScreen", "ExportsScreen", "AuditScreen", "TokensScreen", "StacksPanel", "SigningCredentialsScreen"]) {
    assert.ok(registry.includes(name), `registry must import ${name}`);
  }
});

test("C1: API detail shell renders delivered tab panels (no component: null)", async () => {
  const detail = await source("components/internal/screens/apis/api_detail.jsx");
  for (const name of ["IntegrationsTab", "AuthorizersTab", "ModelsPanel", "CorsPanel", "GatewayResponsesPanel", "DeploymentsTab", "StagesTab", "MonitoringOverview", "DeployButton"]) {
    assert.ok(detail.includes(name), `api_detail must render ${name}`);
  }
  // Only unwired tabs reach the coming-soon panel now.
  assert.ok(detail.includes("!active.wired"));
  assert.ok(!detail.includes("active.owner"), "delivered tabs must not gate on owner");
});

test("C1: stage detail, method view, routes and settings mount their owned panels", async () => {
  const stages = await source("components/internal/screens/releases/stages_tab.jsx");
  assert.ok(stages.includes("StageThrottleTab"), "stage detail mounts S08 throttling");
  assert.ok(stages.includes("StageLoggingTab"), "stage detail mounts S10 logs & tracing");
  const resources = await source("components/internal/screens/apis/resources_tab.jsx");
  assert.ok(resources.includes("MethodDetail"), "resources tab mounts the S06/S07 method view");
  const methodView = await source("components/internal/screens/apis/method_view.jsx");
  for (const name of ["MethodAuthPicker", "MethodRequestEditor", "MethodResponseEditor", "PassthroughPicker", "TestTab"]) {
    assert.ok(methodView.includes(name), `method view mounts ${name}`);
  }
  const routes = await source("components/internal/screens/apis/routes_tab.jsx");
  assert.ok(routes.includes("RouteAuthPicker"), "routes tab mounts the S07 route auth picker");
  const settings = await source("components/internal/screens/apis/settings_tab.jsx");
  assert.ok(settings.includes("ClientCertificatesCard"), "API settings mount S04 client certificates");
  assert.ok(settings.includes("ResourcePolicyEditor"), "API settings mount the S07 resource policy editor");
});

test("C1: JWT debugger decodes locally and rejects malformed tokens", () => {
  const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const header = encode({ alg: "RS256", typ: "JWT", kid: "k1" });
  const payload = encode({ iss: "https://issuer.example.com", aud: "api", exp: 4100000000, sub: "u1" });
  const decoded = authUi.decodeJwtPayload(`Bearer ${header}.${payload}.sig`);
  assert.equal(decoded.header.kid, "k1");
  assert.equal(decoded.payload.sub, "u1");
  assert.throws(() => authUi.decodeJwtPayload("not-a-token"), /header\.payload/);
  assert.throws(() => authUi.decodeJwtPayload(`${encode({ alg: "none" })}.${encode([1, 2])}.s`), /JSON object/);
});

test("C1: policy JSON validation and authorizer capability helpers", () => {
  const { document } = authUi.validatePolicyJson('{"Version":"2012-10-17","Statement":[]}');
  assert.deepEqual(document.Statement, []);
  assert.throws(() => authUi.validatePolicyJson("{oops"), /valid JSON/);
  assert.throws(() => authUi.validatePolicyJson("[1]"), /JSON object/);
  assert.throws(() => authUi.validatePolicyJson(JSON.stringify({ a: 1 }), { maxChars: 5 }), /at most/);
  assert.deepEqual(authUi.authorizerTypesFor("REST"), ["JWT", "TOKEN", "REQUEST"]);
  assert.deepEqual(authUi.authorizerTypesFor("WEBSOCKET"), ["TOKEN", "REQUEST"]);
  assert.deepEqual(authUi.identitySourceExamples("TOKEN", "REST"), ["method.request.header.Authorization"]);
  assert.ok(authUi.identitySourceExamples("REQUEST", "HTTP").includes("$stageVariables.phase"));
});

test("C1: resource policy editor templates match the control plane", () => {
  assert.deepEqual(Object.keys(resourcePolicies.POLICY_TEMPLATES).sort(), ["connectorOnly", "crossProjectAllow", "denyIpRange", "ipAllowList"]);
});
