import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeDb } from "./fake-db.mjs";
import { attachPortalTables } from "./portals.test.mjs";
import { importNewApi } from "../../lib/control/openapi-import.mjs";
import { createDeployment } from "../../lib/control/deployments.mjs";
import { generateSdk, resetSdkJobs } from "../../lib/control/sdks.mjs";
import { listSdkZipNames } from "../../lib/sdk/package.mjs";
import { cleanAgentTools, getAgentTools, putAgentTools } from "../../lib/control/agent-tools.mjs";
import { planStack } from "../../lib/control/stacks.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROJECT = "88888888-8888-4888-8888-888888888888";
const ADMIN = { type: "user", userId: "u-admin" };

function rig() {
  resetSdkJobs();
  return attachPortalTables(createFakeDb({ roles: { "u-admin": "admin" } }));
}

async function seedRest(db) {
  const created = await importNewApi(db, ADMIN, {
    projectId: PROJECT,
    body: {
      document: {
        swagger: "2.0",
        info: { title: "CDE API", version: "1" },
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              responses: { 200: { description: "ok" } },
              "x-amazon-apigateway-integration": { type: "mock" },
            },
          },
        },
      },
    },
    options: {},
  });
  const apiId = created.body.api.id;
  await createDeployment(db, ADMIN, { projectId: PROJECT, apiId, description: "v1", stageName: "prod" });
  return apiId;
}

test("S13 C/D/E: portals migration contract — @up/@down, portal tables, RLS, agent_tools column", async () => {
  const migration = join(ROOT, "supabase", "migrations", "portals", "20261014000001_portals.sql");
  const sql = await readFile(migration, "utf8");
  assert.match(sql, /-- @up/);
  assert.match(sql, /-- @down/);
  for (const table of [
    "pods.portals", "pods.portal_products", "pods.portal_product_links",
    "pods.product_pages", "pods.product_endpoint_pages", "pods.portal_events",
  ]) {
    assert.ok(sql.includes(`create table if not exists ${table}`), table);
    assert.ok(sql.includes(`drop table if exists ${table}`), `down: ${table}`);
  }
  assert.ok(sql.includes("agent_tools"));
  assert.match(sql, /row level security/);
  assert.match(sql, /pods\.portal\.write/);
  assert.match(migration, /20261014000001_portals\.sql$/);
  assert.ok(!/sk-live|secret-value|PRIVATE KEY/.test(sql));
});

test("S13 C/D/E: SDK jobs cache by (deployment, docs, language, config) and gate non-REST", async () => {
  const db = rig();
  const apiId = await seedRest(db);
  const first = await generateSdk(db, ADMIN, {
    projectId: PROJECT, apiId, stageName: "prod", language: "javascript", config: { packageName: "acme-client" },
  });
  assert.equal(first.status, 201);
  assert.ok(listSdkZipNames(first.zip).includes("client.mjs"));
  assert.equal(first.zip.subarray(0, 2).toString("utf8"), "PK");
  const second = await generateSdk(db, ADMIN, {
    projectId: PROJECT, apiId, stageName: "prod", language: "javascript", config: { packageName: "acme-client" },
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.cacheKey, first.body.cacheKey);

  // HTTP APIs are capability-gated (sdk is REST-only).
  const http = await importNewApi(db, ADMIN, {
    projectId: PROJECT,
    body: { document: { openapi: "3.0.3", info: { title: "H", version: "1" }, paths: {} } },
    options: { protocol: "HTTP" },
  });
  await createDeployment(db, ADMIN, { projectId: PROJECT, apiId: http.body.api.id, description: "v1", stageName: "$default" });
  await assert.rejects(
    generateSdk(db, ADMIN, { projectId: PROJECT, apiId: http.body.api.id, stageName: "$default", language: "javascript", config: {} }),
    (error) => error.code === "capability_unsupported",
  );
  await assert.rejects(
    generateSdk(db, ADMIN, { projectId: PROJECT, apiId, stageName: "prod", language: "cobol", config: {} }),
    (error) => error.status === 422,
  );
});

test("S13 C/D/E: agent-tools stage config round-trips and validates", async () => {
  const db = rig();
  const apiId = await seedRest(db);
  const initial = await getAgentTools(db, ADMIN, { projectId: PROJECT, apiId, stageName: "prod" });
  assert.equal(initial.agentTools.enabled, false);
  const saved = await putAgentTools(db, ADMIN, {
    projectId: PROJECT, apiId, stageName: "prod",
    agentTools: { enabled: true, allowOperations: ["listPets"], auth: "passthrough" },
  });
  assert.equal(saved.agentTools.enabled, true);
  assert.deepEqual(saved.agentTools.allowOperations, ["listPets"]);
  assert.deepEqual(cleanAgentTools(null), { enabled: false, allowOperations: null, auth: "passthrough" });
  assert.throws(() => cleanAgentTools({ enabled: true, auth: "oauth" }), /passthrough/);
});

test("S13 C/D/E: portals stack kind plans creates/updates and prune-gates deletes (F25)", async () => {
  const db = rig();
  db.listStackResources = async () => ({ portals: [] });
  const planned = await planStack(db, ADMIN, {
    projectId: PROJECT,
    stack: "docs",
    file: { version: 1, stack: "docs", portals: [{ name: "Dev", slug: "dev-portal-cde" }] },
    prune: false,
  });
  assert.ok(planned.changes.some((entry) => entry.kind === "portals" && entry.op === "create"));
});
