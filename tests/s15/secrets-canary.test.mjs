/**
 * S15 part 1 (security): secret canaries.
 *
 * After a full e2e run (signed request + backend-auth injection + webhook
 * function + API key, with access/execution logs and tracing on), every
 * secret value used must be absent from all outputs: gateway responses,
 * access-log lines, execution-log rows, emitted events, error bodies and the
 * compiled artifact JSON.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryLoader } from "../../gateway/loader.mjs";
import { createGatewayServer } from "../../gateway/server.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { signRequest } from "../../lib/gateway/core/auth/sigv4.mjs";
import { startUpstream } from "../fixtures/upstream.mjs";

process.env.PODS_ALLOW_LOOPBACK = "1";
process.env.PODS_KEY_PEPPER ??= "test-pepper-s15";

const CANARY_BACKEND = "cnry-backend-9f8e7d6c5b4a394031323374657717";
const CANARY_WEBHOOK = "cnry-webhook-11223344556677889900aabbccdd";
const CANARY_SIGNING = "cnry-signing-zz11yy22xx33ww44vv55uu66";
const CANARY_APIKEY = "cnry-apikey-AbC123xYz789qWeRtYuI09876543";
const CANARIES = [CANARY_BACKEND, CANARY_WEBHOOK, CANARY_SIGNING, CANARY_APIKEY];

function restArtifact(upstreamUrl) {
  return {
    schemaVersion: 1,
    projectId: "proj-canary",
    apiId: "api-canary",
    apiPublicId: "canary1234",
    protocol: "REST",
    stage: "prod",
    settings: {},
    resources: [
      { id: "res-root", path: "/" },
      { id: "res-pets", path: "/pets" },
    ],
    methods: {},
    routes: [],
    integrations: {},
    authorizers: {},
    models: {},
    methodsByResource: undefined,
    resourcesList: undefined,
  };
}

function draftFor(upstreamUrl) {
  return {
    projectId: "proj-canary",
    apiId: "api-canary",
    apiPublicId: "canary1234",
    protocol: "REST",
    settings: {},
    resources: [
      { id: "res-root", path: "/" },
      { id: "res-pets", path: "/pets" },
      { id: "res-fn", path: "/fn" },
    ],
    methods: [
      {
        id: "m1",
        resourceId: "res-pets",
        httpMethod: "GET",
        authorizationType: "SIGNED",
        integrationId: "int1",
      },
      {
        id: "m2",
        resourceId: "res-fn",
        httpMethod: "POST",
        authorizationType: "SIGNED",
        integrationId: "int2",
      },
    ],
    integrations: [
      {
        id: "int1",
        type: "HTTP",
        uri: `${upstreamUrl}/status/200`,
        integrationMethod: "GET",
        timeoutMs: 5000,
        backendAuth: { type: "header", headerName: "x-backend-token", secretRef: "secret:backend-1" },
      },
      {
        id: "int2",
        type: "FUNCTION_PROXY",
        timeoutMs: 5000,
        function: { provider: "webhook", url: `${upstreamUrl}/fn`, secretRef: "secret:webhook-1" },
      },
    ],
  };
}

test("S15: secret canary strings absent from all outputs after full e2e run", async () => {
  const upstream = await startUpstream();
  try {
    const { compile } = await import("../../lib/gateway/artifact/compile.mjs");
    const { artifact, errors } = compile(draftFor(upstream.url));
    assert.equal(errors.length, 0, `compile errors: ${JSON.stringify(errors)}`);

    const seen = { events: [], accessLines: [], executionRows: [] };
    const kv = new MemoryKvStore({});
    const ports = {
      kv,
      PODS_KEY_PEPPER: "pepper-canary",
      keyPepper: "pepper-canary",
      events: {
        emit(event) {
          seen.events.push(event);
          if (event?.accessLog?.line) seen.accessLines.push(event.accessLog.line);
          if (event?.accessLog?.row) seen.accessLines.push(JSON.stringify(event.accessLog.row));
          if (event?.executionLog) seen.executionRows.push(JSON.stringify(event.executionLog));
        },
      },
      secrets: {
        async resolve(ref) {
          if (ref === "secret:backend-1") return { value: { value: CANARY_BACKEND } };
          if (ref === "secret:webhook-1") return { value: { value: CANARY_WEBHOOK } };
          throw new Error(`unknown ref ${ref}`);
        },
      },
      signingCredentials: {
        async resolve(id) {
          if (id === "PKIACANARYKEY0001") return { secretAccessKey: CANARY_SIGNING, status: "ACTIVE" };
          return null;
        },
      },
      signingPolicies: {
        async list() {
          return [{
            Version: "2012-10-17",
            Statement: [{ Effect: "Allow", Action: "execute-api:Invoke", Resource: "*" }],
          }];
        },
      },
      allowTestIngress: false,
    };

    const stages = new Map([[`${artifact.apiPublicId}:prod`, {
      artifact,
      stageSettings: {
        accessLog: { enabled: true, format: "$context.requestId $context.httpMethod $context.path $context.status $context.identity.userArn" },
        loggingLevel: "INFO",
        dataTraceEnabled: true,
        tracingEnabled: true,
      },
    }]]);
    const loader = createMemoryLoader({ pathRouting: true, stages });
    const gateway = createGatewayServer({ loader, ports });
    const port = await gateway.start(0);
    const outputs = [];
    try {
      const signed = await signRequest({
        method: "GET",
        url: `http://127.0.0.1:${port}/${artifact.apiPublicId}/prod/pets`,
        headers: {},
        body: "",
        service: "execute-api",
        region: "auto",
        accessKeyId: "PKIACANARYKEY0001",
        secretAccessKey: CANARY_SIGNING,
        timestamp: Date.now(),
      });
      const headers = {};
      for (const [name, value] of Object.entries(signed.headers)) {
        if (name.toLowerCase() === "host") continue;
        headers[name] = value;
      }
      const ok = await fetch(`http://127.0.0.1:${port}/${artifact.apiPublicId}/prod/pets`, { headers });
      outputs.push(`status:${ok.status}`);
      outputs.push(JSON.stringify(Object.fromEntries(ok.headers.entries())));
      outputs.push(await ok.text());
      assert.equal(ok.status, 200, `expected 200, got ${ok.status}`);

      // Webhook function leg (exercises the webhook shared secret).
      const signedFn = await signRequest({
        method: "POST",
        url: `http://127.0.0.1:${port}/${artifact.apiPublicId}/prod/fn`,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
        service: "execute-api",
        region: "auto",
        accessKeyId: "PKIACANARYKEY0001",
        secretAccessKey: CANARY_SIGNING,
        timestamp: Date.now(),
      });
      const fnHeaders = { "content-type": "application/json" };
      for (const [name, value] of Object.entries(signedFn.headers)) {
        if (name.toLowerCase() === "host") continue;
        fnHeaders[name] = value;
      }
      const fnRes = await fetch(`http://127.0.0.1:${port}/${artifact.apiPublicId}/prod/fn`, {
        method: "POST",
        headers: fnHeaders,
        body: JSON.stringify({ hello: "world" }),
      });
      outputs.push(await fnRes.text());
      assert.equal(fnRes.status, 200, `expected fn 200, got ${fnRes.status}`);

      // Error path: unknown route under a known stage must not leak either.
      const signed404 = await signRequest({
        method: "GET",
        url: `http://127.0.0.1:${port}/${artifact.apiPublicId}/prod/nope`,
        headers: {},
        body: "",
        service: "execute-api",
        region: "auto",
        accessKeyId: "PKIACANARYKEY0001",
        secretAccessKey: CANARY_SIGNING,
        timestamp: Date.now(),
      });
      const headers404 = {};
      for (const [name, value] of Object.entries(signed404.headers)) {
        if (name.toLowerCase() === "host") continue;
        headers404[name] = value;
      }
      const notFound = await fetch(`http://127.0.0.1:${port}/${artifact.apiPublicId}/prod/nope`, { headers: headers404 });
      outputs.push(await notFound.text());

      // Let the emit phase flush off-tick.
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      await gateway.close();
    }

    const haystacks = {
      responses: outputs.join("\n"),
      accessLogs: seen.accessLines.join("\n"),
      executionLogs: seen.executionRows.join("\n"),
      events: JSON.stringify(seen.events),
      artifact: JSON.stringify(artifact),
    };

    // Management plane: an API key value is shown once at create and never
    // again (GET/LIST must not carry it).
    const { createFakeDb, makeTestKeys } = await import("../s08/fake-db.mjs");
    const { createApiKey, getApiKey, listApiKeys } = await import("../../lib/control/api-keys.mjs");
    const keyDb = createFakeDb({ roles: { "u-admin": "admin" } });
    const keyDeps = { keys: makeTestKeys(), kv: new MemoryKvStore({}) };
    const created = await createApiKey(keyDb, { type: "user", userId: "u-admin" }, {
      projectId: "proj-canary",
      name: "canary-key",
      value: CANARY_APIKEY,
    }, keyDeps);
    assert.ok(JSON.stringify(created.body).includes(CANARY_APIKEY), "create shows the value once by design");
    const fetched = await getApiKey(keyDb, { type: "user", userId: "u-admin" }, {
      projectId: "proj-canary",
      keyId: created.body.id,
    });
    haystacks.managementGet = JSON.stringify(fetched);
    const listed = await listApiKeys(keyDb, { type: "user", userId: "u-admin" }, { projectId: "proj-canary" });
    haystacks.managementList = JSON.stringify(listed);

    for (const canary of CANARIES) {
      for (const [name, haystack] of Object.entries(haystacks)) {
        assert.ok(
          !haystack.includes(canary),
          `canary ${canary.slice(0, 12)}… leaked into ${name}`,
        );
      }
    }
    assert.ok(seen.events.length > 0, "expected emitted events to scan");
    void restArtifact;
  } finally {
    await upstream.close();
  }
});
