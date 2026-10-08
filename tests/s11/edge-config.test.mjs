/**
 * S11C config-level acceptance: EDGE headers/timeouts, dual-stack source
 * gating, and deploy wiring of API endpoint settings into the artifact.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { compile } from "../../lib/gateway/artifact/compile.mjs";
import { compileDraft } from "../../lib/control/deployments.mjs";
import { buildContext, handle, runPipeline, createPorts } from "../../lib/gateway/core/index.mjs";
import { streamingLimits } from "../../lib/gateway/core/release/streaming.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";

process.env.PODS_ALLOW_LOOPBACK = "1";

function restDraft(edge = {}) {
  return {
    projectId: "proj-1",
    apiId: "api-rest",
    apiPublicId: "edge123456",
    protocol: "REST",
    resources: [{ id: "res-root", path: "/" }, { id: "res-pets", path: "/pets" }],
    methods: [{
      id: "m1", resourceId: "res-pets", httpMethod: "GET",
      authorizationType: "NONE", integrationId: "int1",
    }],
    integrations: [{ id: "int1", type: "MOCK", uri: null, timeoutMs: 5000 }],
    edge,
  };
}

function testPorts() {
  return createPorts({
    kv: new MemoryKvStore({}),
    fetch: globalThis.fetch,
    secrets: { async resolve() { throw new Error("No secret resolver configured."); } },
    events: { emit() {} },
    clock: { now: () => Date.now() },
    log: () => {},
  });
}

test("S11C: EDGE endpoint adds a Via header and uses the 30 s stream idle timeout", async () => {
  const { artifact, errors } = compile(restDraft({ endpointType: "EDGE" }));
  assert.equal(errors.length, 0);

  // Stream limits read the compiled `edge` snapshot (not a top-level field).
  assert.equal(streamingLimits({ artifact }).idleMs, 30 * 1000);
  const { artifact: regional } = compile(restDraft({}));
  assert.equal(streamingLimits({ artifact: regional }).idleMs, 5 * 60 * 1000);

  // Success responses carry the edge Via header …
  const ok = await handle(new Request("http://gw.test/pets"), { ...artifact, allowLoopback: true }, testPorts());
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("via"), "1.1 pods-edge");

  // … and so do gateway errors.
  const denied = await handle(new Request("http://gw.test/unknown"), { ...artifact, allowLoopback: true }, testPorts());
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("via"), "1.1 pods-edge");

  // Non-edge APIs send no Via header.
  const plain = await handle(new Request("http://gw.test/pets"), { ...regional, allowLoopback: true }, testPorts());
  assert.equal(plain.headers.get("via"), null);
});

test("S11C: ipv4 APIs reject IPv6 sources; dualstack APIs serve them", async () => {
  const { artifact: ipv4 } = compile(restDraft({ ipAddressType: "ipv4" }));
  const { artifact: dual } = compile(restDraft({ ipAddressType: "dualstack" }));

  async function get(artifact, sourceIp) {
    const ports = testPorts();
    const ctx = buildContext(new Request("http://gw.test/pets"), { ...artifact, allowLoopback: true }, ports);
    ctx.context.identity.sourceIp = sourceIp;
    return runPipeline(ctx);
  }

  assert.equal((await get(ipv4, "203.0.113.7")).status, 200);
  assert.equal((await get(ipv4, "2001:db8::1")).status, 403);
  assert.equal((await get(dual, "2001:db8::1")).status, 200);
});

test("S11C: deploy carries the API endpoint settings into the artifact edge snapshot", async () => {
  const resources = [{ id: "res-root", path: "/" }, { id: "res-pets", path: "/pets" }];
  const methods = [{
    id: "m1", resource_id: "res-pets", http_method: "GET",
    authorization_type: "NONE", integration_id: "int1",
  }];
  const integrations = [{ id: "int1", type: "MOCK", uri: null, timeout_ms: 5000 }];
  const db = {
    async listResourcesByApi() { return resources; },
    async listMethodsByApi() { return methods; },
    async listIntegrations() { return integrations; },
  };
  const api = {
    id: "api-1", project_id: "proj-1", public_id: "edge123456", protocol: "REST",
    endpoint_type: "EDGE", ip_address_type: "dualstack", disable_default_endpoint: true,
  };
  const { artifact } = await compileDraft(db, api);
  assert.equal(artifact.edge.endpointType, "EDGE");
  assert.equal(artifact.edge.ipAddressType, "dualstack");
  assert.equal(artifact.edge.disableDefaultEndpoint, true);

  // Defaults when the API row predates the columns.
  const { artifact: defaults } = await compileDraft(db, {
    id: "api-1", project_id: "proj-1", public_id: "edge123456", protocol: "REST",
  });
  assert.equal(defaults.edge.endpointType, "REGIONAL");
  assert.equal(defaults.edge.ipAddressType, "ipv4");
  assert.equal(defaults.edge.disableDefaultEndpoint, false);
});
