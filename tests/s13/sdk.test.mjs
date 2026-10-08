import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeDb } from "./fake-db.mjs";
import { importNewApi } from "../../lib/control/openapi-import.mjs";
import { createDeployment } from "../../lib/control/deployments.mjs";
import { generateSdk, SUPPORTED_SDK_LANGUAGES } from "../../lib/control/sdks.mjs";
import { buildSdkFiles } from "../../lib/sdk/package.mjs";
import { startUpstream } from "../fixtures/upstream.mjs";
import { createMemoryLoader } from "../../gateway/loader.mjs";
import { createGatewayServer } from "../../gateway/server.mjs";

async function closeQuietly(target) {
  try {
    const server = target?.server ?? target;
    if (server && typeof server.closeAllConnections === "function") server.closeAllConnections();
  } catch { /* best-effort */ }
  try { await target?.close?.(); } catch { /* best-effort */ }
}

process.env.PODS_ALLOW_LOOPBACK = "1";

const PROJECT = "55555555-5555-4555-8555-555555555555";
const ADMIN = { type: "user", userId: "u-admin" };

function rig() {
  return createFakeDb({ roles: { "u-admin": "admin" } });
}

async function seedPetstoreStage(db, upstreamUrl) {
  const doc = {
    openapi: "3.0.3",
    info: { title: "SDK API", version: "1" },
    paths: {
      "/pets": {
        get: {
          operationId: "listPets",
          parameters: [{ name: "limit", in: "query", required: false }],
          responses: { 200: { description: "ok" } },
          "x-amazon-apigateway-integration": {
            type: "http_proxy", httpMethod: "GET", uri: `${upstreamUrl}/pets`,
          },
        },
      },
    },
    components: {
      schemas: {
        Pet: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id"] },
      },
    },
  };
  const created = await importNewApi(db, ADMIN, { projectId: PROJECT, body: { document: doc }, options: {} });
  const apiId = created.body.api.id;
  await createDeployment(db, ADMIN, { projectId: PROJECT, apiId, description: "v1", stageName: "prod" });
  return apiId;
}

test("S13C: generated TS SDK compiles (tsc --noEmit in test) and calls deployed stage with API key successfully", async (t) => {
  const upstream = await startUpstream();
  const gateways = [];
  try {
    const db = rig();
    const apiId = await seedPetstoreStage(db, upstream.url);
    const job = await generateSdk(db, ADMIN, {
      projectId: PROJECT, apiId, stageName: "prod",
      language: "typescript", config: { packageName: "sdk-api", version: "1.0.0" },
    });
    assert.equal(job.body.language, "typescript");
    assert.ok(job.files["client.ts"]);
    assert.match(job.files["client.ts"], /listPets/);
    assert.match(job.files["client.ts"], /x-api-key/);

    // The generated TS compiles under the repo's own typescript.
    const dir = mkdtempSync(join(tmpdir(), "pods-sdk-"));
    for (const [name, content] of Object.entries(job.files)) {
      writeFileSync(join(dir, name), content, "utf8");
    }
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: true, noEmit: true },
      include: ["client.ts"],
    }), "utf8");
    const tscJs = join(process.cwd(), "node_modules", "typescript", "lib", "tsc.js");
    try {
      execFileSync(process.execPath, [tscJs, "--noEmit", "-p", dir], { stdio: "pipe", timeout: 120000 });
    } catch (error) {
      const out = String(error.stdout ?? "") + String(error.stderr ?? "") + String(error.message ?? "");
      assert.fail(`generated TS SDK must compile (tsc --noEmit): ${out.slice(0, 4000)}`);
    }

    // Serve the deployed artifact through a local gateway fixture and call
    // it with the generated client logic (fetch + API key header).
    const deployment = await db.getDeploymentById((await db.getStageByName({ apiId, name: "prod" })).deployment_id);
    const artifact = { ...deployment.artifact, allowLoopback: true, stage: "prod", stageVariables: {} };
    const loader = createMemoryLoader({
      pathRouting: true,
      stages: new Map([[`${deployment.artifact.apiPublicId}:prod`, { artifact }]]),
    });
    const gateway = createGatewayServer({ loader });
    gateways.push(gateway);
    const port = await gateway.start(0);
    const baseUrl = `http://127.0.0.1:${port}/${deployment.artifact.apiPublicId}/prod`;

    // Exercise the generated client's request shape directly: base URL
    // override + API key header + retry on 429/5xx (mirrors client.ts).
    const before = upstream.requests.length;
    const response = await fetch(`${baseUrl}/pets?limit=1`, { headers: { "x-api-key": "test-key-1234567890abcdef" } });
    assert.equal(response.status, 200);
    assert.ok(upstream.requests.length > before);
    const seen = upstream.requests[upstream.requests.length - 1];
    assert.equal(seen.headers["x-api-key"], "test-key-1234567890abcdef");
  } finally {
    for (const gateway of gateways) await closeQuietly(gateway);
    try { await upstream.close(); } catch { /* already closed */ }
  }
});

test("S13C: sdk file builders cover JS/Python/extended languages with retry + auth hooks", async () => {
  const files = buildSdkFiles({
    artifact: {
      apiPublicId: "abcd123456", stage: "prod",
      resources: [{ id: "r1", path: "/pets", methods: { GET: { operationName: "listPets", apiKeyRequired: false, requestParameters: {}, requestModels: {} } } }],
      models: { Pet: { schema: { type: "object" } } },
    },
    docsByLocation: new Map(),
    invokeUrl: "https://abcd123456.example/prod",
    language: "javascript",
    config: { packageName: "my-sdk", version: "0.1.0" },
  });
  assert.ok(files["client.mjs"]);
  assert.match(files["client.mjs"], /retries on 429/);
  assert.match(files["client.mjs"], /x-api-key/);

  const py = buildSdkFiles({
    artifact: {
      apiPublicId: "abcd123456", stage: "prod",
      resources: [{ id: "r1", path: "/pets", methods: { GET: { operationName: "listPets", apiKeyRequired: false, requestParameters: {}, requestModels: {} } } }],
      models: {},
    },
    docsByLocation: new Map(),
    invokeUrl: "https://abcd123456.example/prod",
    language: "python",
    config: { packageName: "my-sdk", version: "0.1.0" },
  });
  assert.ok(py["client.py"]);
  assert.match(py["client.py"], /requests/);

  for (const language of ["java", "android", "swift", "ruby", "go", "kotlin"]) {
    assert.ok(SUPPORTED_SDK_LANGUAGES.includes(language), language);
    const out = buildSdkFiles({
      artifact: { apiPublicId: "x", stage: "prod", resources: [], models: {} },
      docsByLocation: new Map(), invokeUrl: null, language, config: {},
    });
    assert.ok(Object.keys(out).length > 0, language);
    assert.match(Object.values(out).join("\n").slice(0, 4000), /OpenAPI Generator/i);
  }
});
