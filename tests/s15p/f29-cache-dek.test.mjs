/**
 * F29 (S15): per-stage cache DEK from the vault.
 *
 * - `ports.cacheDek` (explicit) wins; otherwise the vault ref
 *   `cache-dek:<stage>`; otherwise the derived sha256 default.
 * - The resolution source is reported (`resolveStageDek` + `ctx.cacheDekSource`).
 * - A derived fallback in production/strict mode is loud: log + metric event
 *   + `ctx.cacheDekFallback`, never silent.
 * - The control plane provisions the per-stage DEK secret (`generic` kind).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import {
  dekForStage,
  deriveStageKey,
  resolveStageDek,
} from "../../lib/gateway/core/release/cache.mjs";
import { ensureStageCacheDek } from "../../lib/control/stage-cache.mjs";

const STAGE = "api123:prod";

function ctxWith({ ports = {}, artifact = {} } = {}) {
  return { ports, artifact: { projectId: "proj-1", ...artifact } };
}

test("F29: explicit ports.cacheDek wins over vault and derived", async () => {
  const explicit = Buffer.alloc(32, 7);
  const ctx = ctxWith({
    ports: {
      cacheDek: explicit,
      secrets: { resolve: async () => "vault-material" },
    },
  });
  const out = await resolveStageDek(ctx, STAGE);
  assert.equal(out.source, "explicit");
  assert.deepEqual(out.key, explicit);
  assert.equal(ctx.cacheDekSource, "explicit");
  assert.equal(await (await import("../../lib/gateway/core/release/cache.mjs")).dekForStage(ctx, STAGE).then((key) => key.equals(explicit)), true);
});

test("F29: vault cache-dek:<stage> replaces the derived default", async () => {
  const ctx = ctxWith({ ports: { secrets: { resolve: async (ref) => (ref === `cache-dek:${STAGE}` ? "vault-material" : null) } } });
  const out = await resolveStageDek(ctx, STAGE);
  assert.equal(out.source, "vault");
  const derived = deriveStageKey({ projectId: "proj-1", stageId: STAGE });
  assert.ok(!out.key.equals(derived), "vault DEK must differ from the derived default");
  assert.deepEqual(out.key, createHash("sha256").update("vault-material", "utf8").digest());
});

test("F29: unconfigured stage derives silently outside production", async () => {
  const logs = [];
  const events = [];
  const ctx = ctxWith({ ports: { log: { warn: (message) => logs.push(message) }, events: { emit: (event) => events.push(event) } } });
  const out = await resolveStageDek(ctx, STAGE);
  assert.equal(out.source, "derived");
  assert.deepEqual(out.key, deriveStageKey({ projectId: "proj-1", stageId: STAGE }));
  // Back-compat entry point keeps working and stays silent in tests.
  assert.deepEqual(await dekForStage(ctx, STAGE), out.key);
  assert.equal(logs.length, 0);
  assert.equal(events.length, 0);
  assert.equal(ctx.cacheDekFallback ?? false, false);
});

test("F29: production fallback logs and emits a metric (never silent)", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const logs = [];
    const events = [];
    const ctx = ctxWith({ ports: { log: { warn: (...args) => logs.push(args) }, events: { emit: (event) => events.push(event) } } });
    const key = await dekForStage(ctx, STAGE);
    assert.deepEqual(key, deriveStageKey({ projectId: "proj-1", stageId: STAGE }));
    assert.equal(ctx.cacheDekSource, "derived");
    assert.equal(ctx.cacheDekFallback, true);
    assert.ok(logs.length >= 1, "expected a fallback log");
    assert.ok(String(JSON.stringify(logs)).includes("cache"), "log must name the cache DEK");
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "cache_dek_fallback");
    assert.equal(events[0].stageId, STAGE);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test("F29: strict ports flag is loud even outside production", async () => {
  const logs = [];
  const events = [];
  const ctx = ctxWith({
    ports: {
      cacheDekRequired: true,
      log: { warn: (...args) => logs.push(args) },
      events: { emit: (event) => events.push(event) },
    },
  });
  await dekForStage(ctx, STAGE);
  assert.equal(ctx.cacheDekFallback, true);
  assert.ok(logs.length >= 1);
  assert.equal(events.length, 1);
});

test("F29: control plane provisions a per-stage DEK secret once", async () => {
  const secrets = new Map();
  const vault = {
    async getSecretByName({ projectId, name }) {
      return secrets.get(`${projectId}:${name}`) ?? null;
    },
    async createSecret({ projectId, name, kind, value }) {
      assert.equal(kind, "generic");
      assert.match(value, /^[A-Za-z0-9+/]{43}=$/);
      const row = { id: `sec-${secrets.size}`, project_id: projectId, name, kind };
      secrets.set(`${projectId}:${name}`, row);
      return row;
    },
  };
  const first = await ensureStageCacheDek(vault, { projectId: "proj-1", apiPublicId: "api123", stage: "prod" });
  assert.ok(first.name.startsWith("cache-dek-"));
  assert.ok(!first.name.includes(":"));
  const second = await ensureStageCacheDek(vault, { projectId: "proj-1", apiPublicId: "api123", stage: "prod" });
  assert.equal(second.id, first.id);
  assert.equal(secrets.size, 1);
});
