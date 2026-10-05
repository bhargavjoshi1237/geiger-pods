/**
 * B1 production gateway wiring (S05 wiring).
 *
 * Verifies `createProductionPorts` in `gateway/server.mjs` wires the real
 * ports (secrets, signing, usage read-through, sink writers, connector hub)
 * and fails fast in production on missing env / `PODS_ALLOW_LOOPBACK` (F4).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { createProductionPorts, createGatewaySink } from "../../gateway/server.mjs";
import { loadVaultKeys } from "../../lib/vault/keys.mjs";
import { createSecret } from "../../lib/vault/secrets.mjs";
import { hmacForValue } from "../../lib/gateway/core/usage/api-key.mjs";
import { lookupKeyRecord } from "../../lib/gateway/core/usage/api-key.mjs";

function makeVaultEnv(overrides = {}) {
  const kek = randomBytes(32);
  const base = {
    NODE_ENV: "test",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-key-test",
    PODS_KEY_PEPPER: "test-pepper-b1",
    PODS_VAULT_KEYS: JSON.stringify({ k1: kek.toString("base64") }),
    PODS_VAULT_ACTIVE_KID: "k1",
  };
  return { env: { ...base, ...overrides }, kek };
}

function createB1FakeDb() {
  const secrets = new Map();
  const secretVersions = new Map();
  const signingCreds = new Map();
  const signingCredsById = new Map();
  const policiesByCred = new Map();
  const apiKeysByHmac = new Map();
  const apiKeysById = new Map();
  const plansForKey = new Map();
  const plansById = new Map();
  const stagesByPlan = new Map();
  const minuteRows = [];
  const accessLogs = [];
  const executionLogs = [];
  const spans = [];
  let seq = 0;
  let envelopeCalls = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 5, 0, 0, seq++)).toISOString();

  return {
    _test: { secrets, secretVersions, signingCreds, apiKeysByHmac, minuteRows, accessLogs, executionLogs, spans },
    get envelopeCalls() {
      return envelopeCalls;
    },
    async insertSecret(row) {
      const secret = {
        id: randomUUID(), created_at: stamp(), updated_at: stamp(), last_rotated_at: stamp(),
        deleted_at: null, expires_at: null, description: null, current_version: 1, version: 1, ...row,
      };
      secrets.set(secret.id, secret);
      return { ...secret };
    },
    async getSecretById(id) {
      return secrets.get(id) ? { ...secrets.get(id) } : null;
    },
    async updateSecret(id, patch) {
      const current = secrets.get(id);
      if (!current) return null;
      Object.assign(current, patch, { updated_at: stamp() });
      return { ...current };
    },
    async insertSecretVersion(row) {
      const record = { created_at: stamp(), disabled_at: null, ...row };
      secretVersions.set(`${row.secret_id}@${row.version}`, record);
      return { ...record };
    },
    async getSecretVersion(secretId, version) {
      const row = secretVersions.get(`${secretId}@${version}`);
      return row ? { ...row } : null;
    },
    async getSecretVersionEnvelope(secretId, version) {
      envelopeCalls += 1;
      const row = secretVersions.get(`${secretId}@${version}`);
      return row ? { ...row } : null;
    },
    async listSecretVersions(secretId) {
      return [...secretVersions.values()]
        .filter((row) => row.secret_id === secretId)
        .sort((a, b) => b.version - a.version)
        .map((row) => ({ ...row }));
    },
    async updateSecretVersion(secretId, version, patch) {
      const record = secretVersions.get(`${secretId}@${version}`);
      if (!record) return null;
      Object.assign(record, patch);
      return { ...record };
    },
    async countSecretReferences() {
      return 0;
    },
    async getSigningCredentialByKey({ accessKeyId }) {
      const row = signingCreds.get(accessKeyId);
      return row ? { ...row } : null;
    },
    async listSigningPolicies({ credentialId }) {
      return (policiesByCred.get(credentialId) ?? []).map((row) => ({ ...row }));
    },
    async updateSigningCredential({ id, patch }) {
      const row = signingCredsById.get(id);
      if (!row) return null;
      Object.assign(row, patch);
      return { ...row };
    },
    seedSigningCredential(row) {
      const full = { ...row };
      signingCreds.set(full.access_key_id, full);
      signingCredsById.set(full.id, full);
    },
    seedSigningPolicy(credentialId, row) {
      if (!policiesByCred.has(credentialId)) policiesByCred.set(credentialId, []);
      policiesByCred.get(credentialId).push({ ...row });
    },
    async getApiKeyByHmac(hmacHex) {
      const row = apiKeysByHmac.get(hmacHex);
      return row ? { ...row } : null;
    },
    async getApiKeyById(id) {
      const row = apiKeysById.get(id);
      return row ? { ...row } : null;
    },
    async listPlansForKey({ keyId }) {
      return (plansForKey.get(keyId) ?? []).map((row) => ({ ...row }));
    },
    async getPlanById(id) {
      const row = plansById.get(id);
      return row ? { ...row } : null;
    },
    async listPlanStages({ planId }) {
      return (stagesByPlan.get(planId) ?? []).map((row) => ({ ...row }));
    },
    async listQuotaAdjustments() {
      return [];
    },
    async getStageByName() {
      return null;
    },
    async getProjectSettings() {
      return null;
    },
    seedApiKey(row) {
      apiKeysByHmac.set(row.value_hmac, { ...row });
      apiKeysById.set(row.id, { ...row });
    },
    seedPlanMembership(keyId, planId) {
      if (!plansForKey.has(keyId)) plansForKey.set(keyId, []);
      plansForKey.get(keyId).push({ plan_id: planId, api_key_id: keyId });
    },
    seedPlan(plan) {
      plansById.set(plan.id, { ...plan });
    },
    seedPlanStage(planId, stage) {
      if (!stagesByPlan.has(planId)) stagesByPlan.set(planId, []);
      stagesByPlan.get(planId).push({ ...stage });
    },
    async upsertMinuteRows(rows) {
      for (const row of rows ?? []) minuteRows.push({ ...row });
    },
    async insertAccessLogs(rows) {
      for (const row of rows ?? []) accessLogs.push({ ...row });
    },
    async insertExecutionLogs(rows) {
      for (const row of rows ?? []) executionLogs.push({ ...row });
    },
    async insertSpans(rows) {
      for (const row of rows ?? []) spans.push({ ...row });
    },
  };
}

const ACTOR = { type: "user", userId: "u-b1" };

test("S05 wiring: secrets port resolves a ref and never exposes plaintext in logs", async () => {
  const { env } = makeVaultEnv();
  const keys = loadVaultKeys(env);
  const db = createB1FakeDb();
  const created = await createSecret(db, ACTOR, {
    projectId: "proj-b1",
    name: "upstream-key",
    kind: "generic",
    value: { value: "super-secret-plaintext-b1" },
  }, { keys });
  const ref = `secret:${created.id}`;
  const logged = [];
  const kv = new MemoryKvStore({});
  const ports = createProductionPorts({
    env,
    supabase: db,
    kv,
    log: (...args) => logged.push(args.map(String).join(" ")),
  });
  // Unscoped and cross-project resolution are refused.
  await assert.rejects(ports.secrets.resolve(ref));
  await assert.rejects(ports.secrets.forProject("proj-other").resolve(ref));
  const scoped = ports.secrets.forProject("proj-b1");
  const resolved = await scoped.resolve(ref);
  assert.deepEqual(resolved.value, { value: "super-secret-plaintext-b1" });
  assert.equal(resolved.kind, "generic");
  for (const line of logged) {
    assert.ok(!line.includes("super-secret-plaintext-b1"), "plaintext must never appear in logs");
  }
  // Plaintext is cached in-process only: KV must never hold it.
  for (const entry of kv._entries.values()) {
    assert.ok(!String(entry.value).includes("super-secret-plaintext-b1"), "plaintext must never enter KV");
  }
  // Second resolve is served from the in-process cache (no extra envelope read).
  const before = db.envelopeCalls;
  const again = await scoped.resolve(ref);
  assert.deepEqual(again.value, { value: "super-secret-plaintext-b1" });
  assert.equal(db.envelopeCalls, before, "second resolve should hit the in-process cache");
});

test("S05 wiring: signing ports are passed through", async () => {
  const { env } = makeVaultEnv();
  const keys = loadVaultKeys(env);
  const db = createB1FakeDb();
  const created = await createSecret(db, ACTOR, {
    projectId: "proj-b1",
    name: "signing-credential-key",
    kind: "generic",
    value: { value: "test-secret-access-key-b1-0000000001" },
  }, { keys });
  const credentialId = randomUUID();
  db.seedSigningCredential({
    id: credentialId,
    project_id: "proj-b1",
    name: "test-cred",
    access_key_id: "PKIAB1TESTCRED0001",
    secret_ref: `secret:${created.id}`,
    status: "ACTIVE",
    expires_at: null,
  });
  const policy = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "execute-api:Invoke", Resource: "*" }] };
  db.seedSigningPolicy(credentialId, { id: randomUUID(), project_id: "proj-b1", credential_id: credentialId, name: "allow-all", document: policy });
  const kv = new MemoryKvStore({});
  const ports = createProductionPorts({ env, supabase: db, kv });
  const credential = await ports.signingCredentials.resolve("PKIAB1TESTCRED0001");
  assert.equal(credential.secretAccessKey, "test-secret-access-key-b1-0000000001");
  assert.equal(credential.status, "ACTIVE");
  const policies = await ports.signingPolicies.list("PKIAB1TESTCRED0001");
  assert.equal(policies.length, 1);
  assert.deepEqual(policies[0], policy);
});

test("S05 wiring: production ports object includes both signing ports", async () => {
  const { env } = makeVaultEnv();
  const db = createB1FakeDb();
  const kv = new MemoryKvStore({});
  const ports = createProductionPorts({ env, supabase: db, kv });
  assert.ok(ports.signingCredentials && typeof ports.signingCredentials.resolve === "function", "signingCredentials port is required");
  assert.ok(ports.signingPolicies && typeof ports.signingPolicies.list === "function", "signingPolicies port is required (never rely on valid-signature-is-sufficient)");
});

test("S05 wiring: usage read-through finds a key not in KV", async () => {
  const { env } = makeVaultEnv();
  const db = createB1FakeDb();
  const kv = new MemoryKvStore({});
  const value = `B1${"x".repeat(38)}`;
  const pepper = env.PODS_KEY_PEPPER;
  const hmac = hmacForValue(value, pepper);
  const keyId = randomUUID();
  const planId = randomUUID();
  db.seedApiKey({
    id: keyId,
    project_id: "proj-b1",
    public_id: "b1b1b1b1b1",
    name: "b1-key",
    enabled: true,
    value_hmac: hmac,
    value_prefix: value.slice(0, 6),
  });
  db.seedPlan({ id: planId, project_id: "proj-b1", public_id: "pp1", name: "plan", throttle: null, quota: null });
  db.seedPlanMembership(keyId, planId);
  db.seedPlanStage(planId, { plan_id: planId, api_id: "api-b1", stage_name: "prod", method_throttles: {} });

  const ports = createProductionPorts({ env, supabase: db, kv });
  assert.ok(ports.kv.usage && typeof ports.kv.usage.loadKeyRecord === "function", "kv.usage loader is attached");
  assert.equal(ports.keyPepper, pepper);
  // KV starts empty: no cached record.
  assert.equal(await kv.get(`apikey:${hmac}`), null);
  // Direct loader read-through finds the key.
  const viaLoader = await ports.kv.usage.loadKeyRecord(hmac);
  assert.ok(viaLoader && viaLoader.keyId === keyId, "loader read-through finds the key");
  // Engine lookup also finds it through `ports.kv.usage` (no ctx.usage needed).
  const ctx = {
    request: new Request("https://gw.example/pets", { headers: { "x-api-key": value } }),
    artifact: { protocol: "REST", projectId: "proj-b1", apiId: "api-b1", stage: "prod" },
    ports,
    context: { identity: { apiKey: "", apiKeyId: "" } },
  };
  const record = await lookupKeyRecord(ctx, hmac);
  assert.ok(record && record.keyId === keyId, "lookupKeyRecord falls back to ports.kv.usage");
  // Read-through repopulates the KV cache.
  const cached = await kv.get(`apikey:${hmac}`);
  assert.ok(cached && JSON.parse(cached).keyId === keyId, "read-through repopulates KV");
});

test("S05 wiring: sink writers receive batched rows", async () => {
  const { env } = makeVaultEnv();
  const db = createB1FakeDb();
  const kv = new MemoryKvStore({});
  const logged = [];
  const ports = createProductionPorts({ env, supabase: db, kv, log: (...args) => logged.push(args.join(" ")) });
  const sink = createGatewaySink({
    metricsWriter: ports.metricsWriter,
    logsWriter: ports.logsWriter,
    traceWriter: ports.traceWriter,
    log: (...args) => logged.push(args.join(" ")),
  });
  try {
    const ts = new Date().toISOString();
    const event = {
      ts,
      requestId: "req-b1",
      projectId: "proj-b1",
      apiId: "api-b1",
      apiPublicId: "b1b1b1b1b1",
      protocol: "REST",
      stage: "prod",
      status: 200,
      latencyMs: 12,
      routeKey: "GET /pets",
      resourcePath: "/pets",
      httpMethod: "GET",
      accessLog: {
        line: "b1 access line",
        row: {
          project_id: "proj-b1", api_id: "api-b1", stage: "prod", ts, request_id: "req-b1",
          status: 200, route: "GET /pets", source_ip: "1.2.3.4", line: "b1 access line", fields: {},
        },
      },
      executionLog: {
        project_id: "proj-b1", api_id: "api-b1", stage: "prod", request_id: "req-b1",
        ts, level: "INFO", lines: [{ level: "INFO", message: "ok" }], data_trace: false,
      },
      trace: {
        traceId: "trace-b1",
        spans: [{ traceId: "trace-b1", spanId: "span-1", name: "gateway", kind: "server", startMs: Date.now(), endMs: Date.now(), durationMs: 1, attributes: {} }],
      },
    };
    sink.emit(event);
    await new Promise((resolve) => setImmediate(resolve));
    await sink.flushMetrics();
    await sink.flushLogs();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(db._test.minuteRows.length > 0, "metrics writer received rows");
    assert.ok(db._test.accessLogs.length > 0, "access-log writer received rows");
    assert.ok(db._test.executionLogs.length > 0, "execution-log writer received rows");
    assert.ok(db._test.spans.length > 0, "trace writer received spans");
    assert.ok(db._test.accessLogs.some((row) => row.request_id === "req-b1"));
  } finally {
    sink.close();
    try {
      ports.connectorHub?.close?.();
    } catch {
      // Ignore.
    }
  }
});

test("S05 wiring: production env validation throws on missing vars", async () => {
  const { env } = makeVaultEnv();
  const kv = () => new MemoryKvStore({});
  const db = () => createB1FakeDb();
  const prod = (patch) => ({ ...env, NODE_ENV: "production", ...patch });

  assert.throws(() => createProductionPorts({ env: prod({ SUPABASE_URL: "", NEXT_PUBLIC_SUPABASE_URL: "" }), supabase: db(), kv: kv() }), /SUPABASE_URL/);
  assert.throws(() => createProductionPorts({ env: prod({ SUPABASE_SERVICE_ROLE_KEY: "" }), supabase: db(), kv: kv() }), /SUPABASE_SERVICE_ROLE_KEY/);
  assert.throws(() => createProductionPorts({ env: prod({ PODS_KEY_PEPPER: "" }), supabase: db(), kv: kv() }), /PODS_KEY_PEPPER/);
  assert.throws(() => createProductionPorts({ env: prod({ PODS_VAULT_KEYS: "" }), supabase: db(), kv: kv() }), /Vault keys/);
  assert.throws(() => createProductionPorts({ env: prod({ PODS_VAULT_ACTIVE_KID: "missing" }), supabase: db(), kv: kv() }), /Vault keys/);
});

test("S05 wiring: production refuses PODS_ALLOW_LOOPBACK", async () => {
  const { env } = makeVaultEnv();
  const prodEnv = { ...env, NODE_ENV: "production", PODS_ALLOW_LOOPBACK: "1" };
  assert.throws(() => createProductionPorts({ env: prodEnv, supabase: createB1FakeDb(), kv: new MemoryKvStore({}) }), /PODS_ALLOW_LOOPBACK/);
});

test("S05 wiring: non-production falls back without supabase env", async () => {
  const { env } = makeVaultEnv({ NODE_ENV: "test" });
  delete env.SUPABASE_URL;
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  const kv = new MemoryKvStore({});
  const ports = createProductionPorts({ env, supabase: null, kv });
  assert.ok(ports.kv, "kv is still wired");
  assert.ok(ports.signingCredentials && ports.signingPolicies, "signing ports are always present");
  assert.ok(ports.connectorHub && typeof ports.connectorHub.invoke === "function", "connector hub is wired");
  try {
    ports.connectorHub?.close?.();
  } catch {
    // Ignore.
  }
});

test("S05 wiring: connector hub is wired for private integrations", async () => {
  const { env } = makeVaultEnv();
  const db = createB1FakeDb();
  const kv = new MemoryKvStore({});
  const ports = createProductionPorts({ env, supabase: db, kv });
  try {
    assert.ok(ports.connectorHub, "connectorHub port is provided");
    assert.equal(typeof ports.connectorHub.invoke, "function");
    assert.equal(typeof ports.connectorHub.attachSocket, "function");
    assert.equal(typeof ports.connectorHub.status, "function");
  } finally {
    try {
      ports.connectorHub?.close?.();
    } catch {
      // Ignore.
    }
  }
});
