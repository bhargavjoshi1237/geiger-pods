/**
 * S09 canary acceptance tests (bullets 1–3) + canary control validation.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { handle } from "../../lib/gateway/core/index.mjs";
import { pickCanary, shouldRouteToCanary } from "../../lib/gateway/core/release/canary.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { restArtifact, seededRng } from "./helper.mjs";

/** Complementary error function (Abramowitz–Stegun 7.1.26). */
function erfc(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const result = 1 - poly * Math.exp(-x * x);
  return x >= 0 ? 1 - result : 2 - (1 - result);
}

test("S09: seeded RNG with 10% canary routes 10%±1% of 100k simulated requests to canary (chi-square p > 0.01)", () => {
  const rng = seededRng(20261005);
  const total = 100000;
  let canary = 0;
  for (let index = 0; index < total; index += 1) {
    if (pickCanary(10, rng)) canary += 1;
  }
  const expected = total * 0.1;
  assert.ok(Math.abs(canary - expected) <= total * 0.01, `expected 10%±1% (9000–11000), got ${canary}`);
  const chi2 = ((canary - expected) ** 2) / expected + ((total - canary - (total - expected)) ** 2) / (total - expected);
  const p = erfc(Math.sqrt(chi2 / 2));
  assert.ok(p > 0.01, `chi-square p must exceed 0.01, got p=${p} (chi2=${chi2}, canary=${canary})`);
});

test("S09: canary request sees overridden stage variable; base request does not; isCanaryRequest set", async () => {
  // MOCK request template echoes the stage variable so each side is visible.
  const { artifact } = restArtifact({
    integrationOverrides: {
      requestTemplates: { "application/json": "{\"statusCode\": 200, \"env\": \"$stageVariables.env\"}" },
    },
  });
  const base = {
    ...artifact,
    stage: "prod",
    stageVariables: { env: "base" },
    canary: { deploymentId: "d-canary", percentTraffic: 100, stageVariableOverrides: { env: "canary" }, useStageCache: false },
    canaryArtifact: { ...artifact, stage: "prod", deploymentId: "d-canary", stageVariables: { env: "base" } },
  };
  const seen = [];
  const ports = {
    kv: new MemoryKvStore({}),
    events: { emit(event) { seen.push(event); } },
  };
  const response = await handle(
    new Request("https://gw.test/pets", { method: "GET", headers: { "content-type": "application/json" } }),
    base,
    ports,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.env, "canary");
  await new Promise((resolve) => setImmediate(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 25));
  const canaryEvent = seen.find((event) => event.canary === true);
  assert.ok(canaryEvent, "expected an S10 request event with canary:true");
  assert.equal(canaryEvent.stage, "prod");

  // Base request (0% canary): no override, no canary flag.
  const seenBase = [];
  const baseOnly = { ...base, canary: { ...base.canary, percentTraffic: 0 } };
  const responseBase = await handle(
    new Request("https://gw.test/pets", { method: "GET", headers: { "content-type": "application/json" } }),
    baseOnly,
    { kv: new MemoryKvStore({}), events: { emit(event) { seenBase.push(event); } } },
  );
  assert.equal(responseBase.status, 200);
  assert.equal((await responseBase.json()).env, "base");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(seenBase.every((event) => event.canary === false), "base traffic must not be flagged canary");
});

test("S09: promote moves stage to canary deployment, merges overrides when chosen, writes stage_history", async () => {
  const { createFakeDb } = await import("../s05/fake-db.mjs");
  const { createDeployment, resetDeployState, setDeployClock } = await import("../../lib/control/deployments.mjs");
  const { putCanary, promoteCanary } = await import("../../lib/control/canary.mjs");
  const { listStageHistory } = await import("../../lib/control/stages.mjs");
  resetDeployState();
  const PROJECT = "22222222-2222-4222-8222-222222222222";
  const ADMIN = { type: "user", userId: "u-admin" };
  const db = createFakeDb({ roles: { "u-admin": "admin" } });
  const api = await db.insertApi({
    project_id: PROJECT, public_id: "s09promo01", name: "s09-promo", protocol: "REST",
    api_key_source: "HEADER", binary_media_types: [], minimum_compression_size: null,
    missing_route_behavior: "aws", cors: null, resource_policy: null, route_selection_expression: null,
  });
  const int = await db.insertIntegration({
    project_id: PROJECT, api_id: api.id, public_id: "ints09p001", type: "MOCK",
    integration_method: "ANY", uri: null, connection_type: "INTERNET",
    connector_id: null, timeout_ms: 5000, backend_auth: null, function: null, aws: null,
  });
  const root = await db.insertResource({ project_id: PROJECT, api_id: api.id, parent_id: null, path_part: "", path: "/" });
  const pets = await db.insertResource({ project_id: PROJECT, api_id: api.id, parent_id: root.id, path_part: "pets", path: "/pets" });
  await db.insertMethod({
    project_id: PROJECT, api_id: api.id, resource_id: pets.id, http_method: "GET",
    authorization_type: "NONE", authorizer_id: null, authorization_scopes: [],
    api_key_required: false, request_validator_id: null, request_parameters: {},
    request_models: {}, integration_id: int.id,
  });
  const v1 = await createDeployment(db, ADMIN, { projectId: PROJECT, apiId: api.id, description: "v1", stageName: "prod" });
  setDeployClock({ now: () => Date.now() + 5000 });
  const v2 = await createDeployment(db, ADMIN, { projectId: PROJECT, apiId: api.id, description: "v2" });
  const canary = await putCanary(db, ADMIN, {
    projectId: PROJECT, apiId: api.id, stageName: "prod",
    input: { deploymentId: v2.body.id, percentTraffic: 10, stageVariableOverrides: { color: "green" }, useStageCache: false },
  });
  assert.equal(canary.deploymentId, v2.body.id);
  assert.equal(canary.percentTraffic, 10);
  const promoted = await promoteCanary(db, ADMIN, {
    projectId: PROJECT, apiId: api.id, stageName: "prod", mergeVariables: true, removeCanary: false,
  });
  assert.equal(promoted.deploymentId, v2.body.id);
  assert.equal(promoted.mergedVariables, true);
  assert.equal(promoted.canary.percentTraffic, 0);
  const stage = await db.getStageByName({ apiId: api.id, name: "prod" });
  assert.equal(stage.deployment_id, v2.body.id);
  assert.equal(stage.variables.color, "green");
  const { items } = await listStageHistory(db, ADMIN, { projectId: PROJECT, apiId: api.id, stageName: "prod" });
  assert.ok(items.some((entry) => entry.reason === "canary_promote"), `history must include canary_promote: ${items.map((entry) => entry.reason)}`);
  resetDeployState();
});

test("S09: sticky canary assigns the same client consistently", () => {
  const canary = { percentTraffic: 50, sticky: { source: "header", name: "x-client" } };
  const requestFor = (value) => new Request("https://gw.test/pets", { headers: { "x-client": value } });
  const first = shouldRouteToCanary({ canary, request: requestFor("alice"), rng: seededRng(1) });
  for (let index = 0; index < 25; index += 1) {
    assert.equal(
      shouldRouteToCanary({ canary, request: requestFor("alice"), rng: seededRng(1000 + index) }),
      first,
      "sticky value must route consistently regardless of RNG",
    );
  }
});
