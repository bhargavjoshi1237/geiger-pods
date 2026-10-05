import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// --- F5: max_integration_timeout_ms ------------------------------------------

test("F5: REST timeout defaults to 29000 and rises to 300000 via project setting", async () => {
  const { createIntegration } = await import("../../lib/control/integrations.mjs");
  const PROJECT = "f5000000-0000-4000-8000-000000000000";
  const REST_API = "f5000000-0000-4000-8000-000000000001";
  const ADMIN = { type: "user", userId: "u-admin" };
  function fakeDb(setting) {
    const store = { integrations: new Map(), audits: [] };
    return {
      async getInheritedRole() { return "admin"; },
      async listRoleBindings() { return { roles: [], grants: [] }; },
      async insertAudit(entry) { store.audits.push(entry); },
      async getApiProtocol() { return "REST"; },
      async getProjectSettings() {
        return setting === null ? null : { max_integration_timeout_ms: setting, version: 1 };
      },
      async listIntegrations({ apiId, limit }) {
        return [...store.integrations.values()].filter((r) => r.api_id === apiId).slice(0, limit);
      },
      async getIntegrationById(id) { return store.integrations.get(id) ?? null; },
      async insertIntegration(row) {
        const saved = { id: randomUUID(), created_at: "2026-10-05T00:00:01.000Z", updated_at: "2026-10-05T00:00:01.000Z", deleted_at: null, version: 1, ...row };
        store.integrations.set(saved.id, saved);
        return saved;
      },
      async updateIntegration(id, patch) {
        Object.assign(store.integrations.get(id), patch);
        return store.integrations.get(id);
      },
      async deleteIntegration(id) { store.integrations.get(id).deleted_at = "x"; return { id, deleted: true }; },
      async listIntegrationResponses() { return []; },
      async countSecretReferences() { return 0; },
    };
  }
  // Default ceiling: 30000 is rejected for REST.
  const dbDefault = fakeDb(null);
  await assert.rejects(
    createIntegration(dbDefault, ADMIN, { projectId: PROJECT, apiId: REST_API, input: { type: "MOCK", timeoutMs: 30000 } }),
    (e) => e.status === 422,
  );
  // Raised ceiling: 100000 is accepted when the setting allows it.
  const dbRaised = fakeDb(300000);
  const created = await createIntegration(dbRaised, ADMIN, { projectId: PROJECT, apiId: REST_API, input: { type: "MOCK", timeoutMs: 100000 } });
  assert.equal(created.body.timeoutMs, 100000);
  // Even raised, 300001 is rejected (hard max).
  await assert.rejects(
    createIntegration(dbRaised, ADMIN, { projectId: PROJECT, apiId: REST_API, input: { type: "MOCK", timeoutMs: 300001 } }),
    (e) => e.status === 422,
  );
});

test("F5: project_settings migration adds max_integration_timeout_ms with @up/@down", () => {
  const file = join(ROOT, "supabase", "migrations", "foundation", "20261010000003_project_settings_timeout.sql");
  const body = readFileSync(file, "utf8");
  assert.ok(body.includes("-- @up") && body.includes("-- @down"));
  assert.ok(body.includes("max_integration_timeout_ms"));
  assert.ok(body.includes("300000"));
});

// --- F6 --------------------------------------------------------------------

test("F6: processing FK migration references rest_methods and integrations with @up/@down", () => {
  const file = join(ROOT, "supabase", "migrations", "processing", "20261010000004_processing_fks.sql");
  const body = readFileSync(file, "utf8");
  assert.ok(body.includes("-- @up") && body.includes("-- @down"));
  assert.ok(body.includes("references pods.rest_methods"), "missing FK to rest_methods");
  assert.ok(body.includes("references pods.integrations"), "missing FK to integrations");
});

// --- F8 --------------------------------------------------------------------

test("F8: quickCreate provisions HTTP_PROXY integration, $default route link, $default autoDeploy stage and deployment", async () => {
  const { createApi } = await import("../../lib/control/apis.mjs");
  const PROJECT = "f8000000-0000-4000-8000-000000000000";
  const ADMIN = { type: "user", userId: "u-admin" };
  const store = { apis: new Map(), routes: new Map(), integrations: new Map(), stages: new Map(), deployments: new Map(), audits: [] };
  let seq = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 5, 0, 0, ++seq)).toISOString();
  const db = {
    async getInheritedRole() { return "owner"; },
    async listRoleBindings() { return { roles: [], grants: [] }; },
    async insertAudit(e) { store.audits.push(e); },
    async getApiByName({ projectId, name }) {
      for (const r of store.apis.values()) if (!r.deleted_at && r.project_id === projectId && r.name === name) return { ...r };
      return null;
    },
    async getApiByRef({ projectId, ref }) {
      for (const r of store.apis.values()) if (!r.deleted_at && r.project_id === projectId && (r.id === ref || r.public_id === ref)) return { ...r };
      return null;
    },
    async insertApi(row) {
      const full = { id: randomUUID(), version: 1, created_at: stamp(), updated_at: stamp(), deleted_at: null, ...row };
      store.apis.set(full.id, full);
      return { ...full };
    },
    async listResourcesByApi() { return []; },
    async listMethodsByApi() { return []; },
    async listRoutesByApi({ apiId }) { return [...store.routes.values()].filter((r) => r.api_id === apiId && !r.deleted_at); },
    async getRouteByKey({ apiId, routeKey }) {
      for (const r of store.routes.values()) if (!r.deleted_at && r.api_id === apiId && r.route_key === routeKey) return { ...r };
      return null;
    },
    async insertRoute(row) {
      const full = { id: randomUUID(), version: 1, created_at: stamp(), updated_at: stamp(), deleted_at: null, ...row };
      store.routes.set(full.id, full);
      return { ...full };
    },
    async updateRoute({ id, patch }) {
      const row = store.routes.get(id);
      const next = { ...row, ...patch, updated_at: stamp() };
      store.routes.set(id, next);
      return { ...next };
    },
    async insertIntegration(row) {
      const full = { id: randomUUID(), version: 1, created_at: stamp(), updated_at: stamp(), deleted_at: null, ...row };
      store.integrations.set(full.id, full);
      return { ...full };
    },
    async listIntegrations({ apiId, limit = 1000 }) {
      return [...store.integrations.values()].filter((r) => r.api_id === apiId && !r.deleted_at).slice(0, limit);
    },
    async listModels() { return []; },
    async listRequestValidators() { return []; },
    async listGatewayResponses() { return []; },
    async listAuthorizers() { return []; },
    async getStageByName({ apiId, name }) {
      for (const r of store.stages.values()) if (r.api_id === apiId && r.name === name) return { ...r };
      return null;
    },
    async listStages({ apiId }) { return [...store.stages.values()].filter((r) => r.api_id === apiId); },
    async insertStage(row) {
      const full = { id: randomUUID(), version: 1, created_at: stamp(), updated_at: stamp(), ...row };
      store.stages.set(full.id, full);
      return { ...full };
    },
    async updateStage({ id, patch }) {
      const row = store.stages.get(id);
      const next = { ...row, ...patch, updated_at: stamp() };
      store.stages.set(id, next);
      return { ...next };
    },
    async insertStageHistory(e) { return { id: randomUUID(), ...e }; },
    async insertDeployment(row) {
      const full = { created_at: stamp(), ...row };
      store.deployments.set(full.id, full);
      return { ...full };
    },
    async getDeploymentById(id) { return store.deployments.get(id) ?? null; },
    async getProjectSettings() { return null; },
  };
  const created = await createApi(db, ADMIN, { projectId: PROJECT, name: "Quick", protocol: "HTTP", quickCreate: { target: "https://backend.example.com/api" } });
  assert.equal(created.status, 201);
  assert.ok(!("quickCreatePending" in created.body), "quickCreate should be fully provisioned, not pending");
  assert.equal(store.integrations.size, 1);
  const integration = [...store.integrations.values()][0];
  assert.equal(integration.type, "HTTP_PROXY");
  assert.equal(integration.uri, "https://backend.example.com/api");
  const route = [...store.routes.values()].find((r) => r.route_key === "$default");
  assert.ok(route, "missing $default route");
  assert.equal(route.integration_id, integration.id, "route must link the integration");
  const stage = [...store.stages.values()].find((r) => r.name === "$default");
  assert.ok(stage, "missing $default stage");
  assert.equal(stage.auto_deploy, true);
  assert.equal(store.deployments.size, 1, "first deployment must be triggered");
  assert.equal(stage.deployment_id ?? (await db.getStageByName({ apiId: created.body.id, name: "$default" })).deployment_id, [...store.deployments.values()][0].id);
});

// --- F11 -------------------------------------------------------------------

test("F11: secrets screen has disable-version action, last-rotated column and used-by pre-check", () => {
  const file = join(ROOT, "components", "internal", "screens", "secrets", "secrets_screen.jsx");
  const body = readFileSync(file, "utf8");
  assert.ok(body.includes("/versions/") && body.includes("/disable"), "missing disable-version action");
  assert.ok(body.includes("lastRotatedAt"), "missing last-rotated column");
  assert.ok(body.includes("usedBy") && body.includes("still referenced"), "missing used-by pre-check before delete");
});

// --- F12 -------------------------------------------------------------------

test("F12: countSecretReferences only swallows missing-table errors", async () => {
  const { createControlDb } = await import("../../lib/control/supabase-db.mjs");
  function clientWith(error) {
    return {
      schema() {
        return {
          from() {
            return {
              select() {
                return {
                  is: async () => ({ data: null, error }),
                };
              },
            };
          },
        };
      },
    };
  }
  const missing1 = createControlDb(clientWith({ code: "42P01", message: "undefined_table" }));
  assert.equal(await missing1.countSecretReferences("abc"), 0);
  const missing2 = createControlDb(clientWith({ code: "PGRST205", message: "not found" }));
  assert.equal(await missing2.countSecretReferences("abc"), 0);
  const broken = createControlDb(clientWith({ code: "500", message: "boom" }));
  await assert.rejects(broken.countSecretReferences("abc"), (e) => e?.code === "500" || /boom/.test(e?.message ?? ""));
});

// --- F13 -------------------------------------------------------------------

test("F13: audit cursor requires an id tiebreak", async () => {
  const { listAuditEvents } = await import("../../lib/control/audit.mjs");
  const db = {
    async getInheritedRole() { return "admin"; },
    async listRoleBindings() { return { roles: [], grants: [] }; },
    async listAudit() { return { items: [], nextCursor: null }; },
  };
  const actor = { type: "user", userId: "u1" };
  const good = Buffer.from(JSON.stringify({ createdAt: "2026-10-05T00:00:01.000Z", id: "11111111-1111-4111-8111-111111111111" }), "utf8").toString("base64url");
  await listAuditEvents(db, actor, { projectId: "p", cursor: good });
  const bad = Buffer.from(JSON.stringify({ createdAt: "2026-10-05T00:00:01.000Z" }), "utf8").toString("base64url");
  await assert.rejects(
    listAuditEvents(db, actor, { projectId: "p", cursor: bad }),
    (e) => e.status === 400,
  );
});

test("F13: settings.features is writable with validated keys only", async () => {
  const { updateSettings, getSettings } = await import("../../lib/control/settings.mjs");
  const PROJECT = "f1300000-0000-4000-8000-000000000000";
  const ADMIN = { type: "user", userId: "u-admin" };
  let stored = null;
  const audits = [];
  const db = {
    async getInheritedRole() { return "admin"; },
    async listRoleBindings() { return { roles: [], grants: [] }; },
    async getProjectSettings() { return stored; },
    async upsertProjectSettings(next) { stored = { ...next }; return stored; },
    async insertAudit(e) { audits.push(e); },
  };
  const updated = await updateSettings(db, ADMIN, { projectId: PROJECT, patch: { features: { rateLimitHeaders: true, instanceCount: 3 } } });
  assert.equal(updated.features.rateLimitHeaders, true);
  assert.equal(updated.features.instanceCount, 3);
  await assert.rejects(
    updateSettings(db, ADMIN, { projectId: PROJECT, patch: { features: { bogusFlag: true } } }),
    (e) => e.status === 422,
  );
  await assert.rejects(
    updateSettings(db, ADMIN, { projectId: PROJECT, patch: { features: { rateLimitHeaders: "yes" } } }),
    (e) => e.status === 422,
  );
  const viewed = await getSettings(db, ADMIN, { projectId: PROJECT });
  assert.equal(viewed.features.rateLimitHeaders, true);
});

// --- F19 -------------------------------------------------------------------

test("F19: upstream /sleep/* replies even though req.destroyed is true on Node 24", async () => {
  const { startUpstream } = await import("../../tests/fixtures/upstream.mjs");
  const upstream = await startUpstream();
  try {
    const response = await fetch(`${upstream.url}/sleep/30`, { method: "POST", body: JSON.stringify({ hello: "world" }), headers: { "content-type": "application/json" } });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.path, "/sleep/30");
  } finally {
    await upstream.close();
  }
});

// --- F20 -------------------------------------------------------------------

test("F20: draft mutations schedule autoDeploy via the shared audit hook", async () => {
  const { resetDeployState, wasAutoDeployScheduled } = await import("../../lib/control/deployments.mjs");
  const { createRoute } = await import("../../lib/control/http-routes.mjs");
  const { createIntegration } = await import("../../lib/control/integrations.mjs");
  const PROJECT = "f2000000-0000-4000-8000-000000000000";
  resetDeployState();
  let seq = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 5, 0, 0, ++seq)).toISOString();
  const apiRow = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", project_id: PROJECT, public_id: "a1b2c3d4e5", protocol: "HTTP", name: "H", api_key_source: "HEADER", binary_media_types: [], endpoint_type: "REGIONAL", missing_route_behavior: "aws" };
  const store = { routes: new Map(), integrations: new Map(), audits: [] };
  const db = {
    async getInheritedRole() { return "owner"; },
    async listRoleBindings() { return { roles: [], grants: [] }; },
    async insertAudit(e) { store.audits.push(e); },
    async getApiByRef() { return { ...apiRow }; },
    async getApiProtocol() { return "HTTP"; },
    async getRouteByKey() { return null; },
    async insertRoute(row) {
      const full = { id: randomUUID(), version: 1, created_at: stamp(), updated_at: stamp(), deleted_at: null, ...row };
      store.routes.set(full.id, full);
      return { ...full };
    },
    async insertIntegration(row) {
      const full = { id: randomUUID(), version: 1, created_at: stamp(), updated_at: stamp(), deleted_at: null, ...row };
      store.integrations.set(full.id, full);
      return { ...full };
    },
    async listIntegrations() { return []; },
  };
  const actor = { type: "user", userId: "u1" };
  await createRoute(db, actor, { projectId: PROJECT, apiId: apiRow.id, routeKey: "GET /pets" });
  assert.equal(wasAutoDeployScheduled(PROJECT, apiRow.id), true, "route mutation must schedule autoDeploy");
  resetDeployState();
  await createIntegration(db, actor, { projectId: PROJECT, apiId: apiRow.id, input: { type: "HTTP_PROXY", uri: "https://b.example.com/x" } });
  assert.equal(wasAutoDeployScheduled(PROJECT, apiRow.id), true, "integration mutation must schedule autoDeploy");
  resetDeployState();
});

test("F20: flushAutoDeploys runs pending auto-deploys immediately (serverless after() path)", async () => {
  const { resetDeployState, scheduleAutoDeploy, hasPendingAutoDeploys, flushAutoDeploys } = await import("../../lib/control/deployments.mjs");
  resetDeployState();
  const PROJECT = "f2000000-0000-4000-8000-000000000001";
  const apiRow = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", project_id: PROJECT, public_id: "b1b2c3d4e5", protocol: "HTTP" };
  const listed = [];
  const db = {
    async getApiByRef() { return { ...apiRow }; },
    async listStages({ apiId }) {
      listed.push(apiId);
      return [];
    },
  };
  scheduleAutoDeploy(db, { projectId: PROJECT, apiId: apiRow.id });
  scheduleAutoDeploy(db, { projectId: PROJECT, apiId: apiRow.id });
  assert.equal(hasPendingAutoDeploys(), true);
  await flushAutoDeploys();
  assert.equal(hasPendingAutoDeploys(), false);
  assert.deepEqual(listed, [apiRow.id], "debounced schedules collapse into one run");
  resetDeployState();
});

// --- F21 -------------------------------------------------------------------

test("F21: deploy lock is a lease row behind permission-checked SECURITY DEFINER functions", () => {
  const file = join(ROOT, "supabase", "migrations", "releases", "20261010000005_deploy_advisory_lock.sql");
  const body = readFileSync(file, "utf8");
  assert.ok(body.includes("-- @up") && body.includes("-- @down"));
  // Transaction-scoped advisory locks would be released when the rpc returns.
  assert.ok(!body.includes("pg_try_advisory_xact_lock"));
  assert.match(body, /create table if not exists pods\.deploy_locks/);
  assert.match(body, /function pods\.acquire_deploy_lock[\s\S]*security definer[\s\S]*set search_path = ''[\s\S]*pods\.can\('pods\.deployment\.create'/);
  assert.match(body, /where l\.expires_at < pg_catalog\.now\(\)/);
  assert.match(body, /function pods\.release_deploy_lock[\s\S]*holder = p_holder/);
});

test("F21: supabase db advisoryLock returns a releasable lease, false when held, undefined when missing", async () => {
  const { createControlDb } = await import("../../lib/control/supabase-db.mjs");
  const calls = [];
  const okClient = {
    schema() {
      return {
        rpc: async (name, args) => {
          calls.push({ name, args });
          return { data: name === "acquire_deploy_lock" ? true : null, error: null };
        },
      };
    },
  };
  const lease = await createControlDb(okClient).advisoryLock({ apiId: "a" });
  assert.equal(typeof lease.release, "function");
  await lease.release();
  assert.deepEqual(calls.map((call) => call.name), ["acquire_deploy_lock", "release_deploy_lock"]);
  assert.equal(calls[1].args.p_holder, calls[0].args.p_holder, "release uses the same holder");
  const lockedClient = {
    schema() {
      return { rpc: async () => ({ data: false, error: null }) };
    },
  };
  assert.equal(await createControlDb(lockedClient).advisoryLock({ apiId: "a" }), false);
  const missingClient = {
    schema() {
      return { rpc: async () => ({ data: null, error: { code: "PGRST202", message: "missing" } }) };
    },
  };
  assert.equal(await createControlDb(missingClient).advisoryLock({ apiId: "a" }), undefined);
});

// --- F24 -------------------------------------------------------------------

test("F24: integration_responses_write RLS checks the parent is not soft-deleted", () => {
  const file = join(ROOT, "supabase", "migrations", "integrations", "20261010000006_integration_responses_rls.sql");
  const body = readFileSync(file, "utf8");
  assert.ok(body.includes("-- @up") && body.includes("-- @down"));
  assert.ok(body.includes("integration_responses_write"));
  assert.ok(body.includes("deleted_at is null"), "write policy must check parent deleted_at");
});

test("F24: recordHeartbeat requires the service role", async () => {
  const { recordHeartbeat } = await import("../../lib/control/connectors.mjs");
  const db = {
    async getConnectorById(id) { return { id, project_id: "p" }; },
    async updateConnector(id, patch) { return { id, project_id: "p", name: "c", status: patch.status, status_message: patch.status_message, allowed_targets: [], agent_count: patch.agent_count, last_seen_at: patch.last_seen_at, version: 1, created_at: "2026-10-05T00:00:01.000Z", updated_at: "2026-10-05T00:00:01.000Z" }; },
  };
  await assert.rejects(
    recordHeartbeat(db, { connectorId: "c", agentCount: 1, status: "AVAILABLE" }),
    (e) => e.status === 403,
  );
  const ok = await recordHeartbeat(db, { connectorId: "c", agentCount: 2, status: "AVAILABLE" }, { serviceRole: true });
  assert.equal(ok.agentCount, 2);
  const { readFileSync: read } = await import("node:fs");
  const routes = ["app/api/v1/projects/[projectId]/connectors/route.js", "app/api/v1/projects/[projectId]/connectors/[connectorId]/route.js"];
  for (const rel of routes) {
    const body = read(join(ROOT, rel), "utf8");
    assert.ok(!body.includes("recordHeartbeat"), `${rel} must not expose heartbeat to users`);
  }
});

// --- F26 -------------------------------------------------------------------

test("F26: ?tag filters narrow apis, stages, api-keys and usage-plans", async () => {
  const { listApis } = await import("../../lib/control/apis.mjs");
  const { listStages } = await import("../../lib/control/stages.mjs");
  const { listApiKeys } = await import("../../lib/control/api-keys.mjs");
  const { listPlans } = await import("../../lib/control/usage-plans.mjs");
  const PROJECT = "f2600000-0000-4000-8000-000000000000";
  const OWNER = { type: "user", userId: "u-owner" };
  const apiRows = [
    { id: "11111111-1111-4111-8111-111111111111", project_id: PROJECT, public_id: "a1b2c3d4e1", name: "prod", protocol: "HTTP", tags: { env: "prod" }, created_at: "2026-10-05T00:00:01.000Z", version: 1 },
    { id: "22222222-2222-4222-8222-222222222222", project_id: PROJECT, public_id: "a1b2c3d4e2", name: "dev", protocol: "HTTP", tags: { env: "dev" }, created_at: "2026-10-05T00:00:02.000Z", version: 1 },
  ];
  const apiDb = {
    async getInheritedRole() { return "owner"; },
    async listRoleBindings() { return { roles: [], grants: [] }; },
    async listApis() { return apiRows; },
  };
  const filteredApis = await listApis(apiDb, OWNER, { projectId: PROJECT, tagFilters: [{ key: "env", value: "prod" }] });
  assert.equal(filteredApis.items.length, 1);
  assert.equal(filteredApis.items[0].name, "prod");
  const allApis = await listApis(apiDb, OWNER, { projectId: PROJECT });
  assert.equal(allApis.items.length, 2);

  const stageDb = {
    async getInheritedRole() { return "owner"; },
    async listRoleBindings() { return { roles: [], grants: [] }; },
    async getApiByRef() { return { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", project_id: PROJECT, public_id: "a1b2c3d4e5", protocol: "HTTP" }; },
    async listStages() {
      return [
        { id: "s1", project_id: PROJECT, api_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "prod", tags: { team: "a" }, deployment_id: null, version: 1, created_at: "2026-10-05T00:00:01.000Z", updated_at: "2026-10-05T00:00:01.000Z" },
        { id: "s2", project_id: PROJECT, api_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "dev", tags: { team: "b" }, deployment_id: null, version: 1, created_at: "2026-10-05T00:00:02.000Z", updated_at: "2026-10-05T00:00:02.000Z" },
      ];
    },
  };
  const stages = await listStages(stageDb, OWNER, { projectId: PROJECT, apiId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", tagFilters: [{ key: "team", value: "b" }] });
  assert.equal(stages.items.length, 1);
  assert.equal(stages.items[0].name, "dev");

  const keyDb = {
    async getInheritedRole() { return "admin"; },
    async listRoleBindings() { return { roles: [], grants: [] }; },
    async listApiKeys() {
      return [
        { id: "k1", project_id: PROJECT, public_id: "p1", name: "one", enabled: true, value_prefix: "ab", tags: { env: "prod" }, version: 1, created_at: "2026-10-05T00:00:01.000Z", updated_at: "2026-10-05T00:00:01.000Z" },
        { id: "k2", project_id: PROJECT, public_id: "p2", name: "two", enabled: true, value_prefix: "cd", tags: { env: "dev" }, version: 1, created_at: "2026-10-05T00:00:02.000Z", updated_at: "2026-10-05T00:00:02.000Z" },
      ];
    },
  };
  const keys = await listApiKeys(keyDb, { type: "user", userId: "u-admin" }, { projectId: PROJECT, tagFilters: [{ key: "env", value: "dev" }] });
  assert.equal(keys.items.length, 1);
  assert.equal(keys.items[0].name, "two");

  const planDb = {
    async getInheritedRole() { return "admin"; },
    async listRoleBindings() { return { roles: [], grants: [] }; },
    async listPlans() {
      return [
        { id: "p1", project_id: PROJECT, public_id: "q1", name: "gold", tags: { tier: "gold" }, version: 1, created_at: "2026-10-05T00:00:01.000Z", updated_at: "2026-10-05T00:00:01.000Z" },
        { id: "p2", project_id: PROJECT, public_id: "q2", name: "silver", tags: { tier: "silver" }, version: 1, created_at: "2026-10-05T00:00:02.000Z", updated_at: "2026-10-05T00:00:02.000Z" },
      ];
    },
  };
  const plans = await listPlans(planDb, { type: "user", userId: "u-admin" }, { projectId: PROJECT, tagFilters: [{ key: "tier", value: "gold" }] });
  assert.equal(plans.items.length, 1);
  assert.equal(plans.items[0].name, "gold");
});
