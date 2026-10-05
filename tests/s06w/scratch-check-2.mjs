/**
 * SCRATCH smoke checks part 2 for S06W (deleted before finishing).
 */
import assert from "node:assert/strict";
import http from "node:http";
import { gzipSync, gunzipSync } from "node:zlib";
import { startUpstream } from "../fixtures/upstream.mjs";
import { compileOrThrow, restDraft, httpDraft } from "./helper.mjs";
import { runHarness } from "./scratch-harness.mjs";

const RESOURCES = [
  { id: "res-root", path: "/" },
  { id: "res-items", path: "/items" },
];

const upstream = await startUpstream();
try {
  // 6. REST HTTP-custom VTL request template + responseOverride.
  {
    const draft = restDraft(upstream.url, {
      apiPublicId: "scrt0000000006",
      resources: RESOURCES,
      method: {
        httpMethod: "POST",
        methodResponses: [{ statusCode: "201", responseParameters: {}, responseModels: {} }],
      },
      integration: {
        type: "HTTP",
        uri: `${upstream.url}/echo`,
        requestTemplates: {
          "application/json": '{"statusCode":200,"joined":"#foreach($i in $input.path(\'$.items\'))$i#if($foreach.hasNext),#end#end"}#set($context.requestOverride.header["X-From-Template"] = "yes")',
        },
        integrationResponses: [{
          statusCode: "201", selectionPattern: "", responseParameters: {},
          responseTemplates: {
            "application/json": '#set($context.responseOverride.status = 202)#set($context.responseOverride.header["X-Resp"] = "r1"){"ok":true}',
          },
        }],
      },
    });
    const artifact = { ...compileOrThrow(draft), stage: "prod" };
    const res = await runHarness(
      new Request("http://gw.test/items", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: ["a", "b"] }),
      }),
      artifact, "/items",
    );
    assert.equal(res.status, 202);
    assert.equal(res.headers.get("x-resp"), "r1");
    const seen = upstream.requests[upstream.requests.length - 1];
    assert.equal(seen.headers["x-from-template"], "yes");
    assert.equal(JSON.parse(seen.body.toString("utf8")).joined, "a,b");
    console.log("6. REST custom VTL + overrides OK");
  }
  // 7. Status regex selection + default + no-default 500.
  {
    const sel = async (uri, rows, codes, accept = null) => {
      const draft = restDraft(upstream.url, {
        apiPublicId: `scrt0000000${Math.floor(Math.random() * 90 + 10)}`,
        resources: RESOURCES,
        method: { methodResponses: codes.map((statusCode) => ({ statusCode, responseParameters: {}, responseModels: {} })) },
        integration: { type: "HTTP", uri, integrationResponses: rows },
      });
      const artifact = { ...compileOrThrow(draft), stage: "prod" };
      const headers = accept ? { accept } : {};
      return runHarness(new Request("http://gw.test/items", { headers }), artifact, "/items");
    };
    const r1 = await sel(`${upstream.url}/status/201`, [
      { statusCode: "200", selectionPattern: "2..", responseParameters: {}, responseTemplates: {} },
      { statusCode: "500", selectionPattern: "", responseParameters: {}, responseTemplates: {} },
    ], ["200", "500"]);
    assert.equal(r1.status, 200);
    const r2 = await sel(`${upstream.url}/status/201`, [
      { statusCode: "500", selectionPattern: "5..", responseParameters: {}, responseTemplates: {} },
      { statusCode: "200", selectionPattern: "", responseParameters: {}, responseTemplates: {} },
    ], ["200", "500"]);
    assert.equal(r2.status, 200);
    const r3 = await sel(`${upstream.url}/status/200`, [
      { statusCode: "500", selectionPattern: "5..", responseParameters: {}, responseTemplates: {} },
    ], ["500"]);
    assert.equal(r3.status, 500);
    console.log("7. selection/default/no-default OK");
  }
  // 8. Binary round trip HTTP_PROXY.
  {
    const draft = restDraft(upstream.url, {
      apiPublicId: "scrt0000000008",
      resources: RESOURCES,
      method: { httpMethod: "POST" },
      integration: { type: "HTTP_PROXY", uri: `${upstream.url}/echo` },
      extra: { settings: { binaryMediaTypes: ["image/png"] } },
    });
    const artifact = { ...compileOrThrow(draft), stage: "prod" };
    const sent = Buffer.from([0, 255, 137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
    const res = await runHarness(
      new Request("http://gw.test/items", {
        method: "POST", headers: { "content-type": "image/png", accept: "image/png" }, body: sent,
      }),
      artifact, "/items",
    );
    assert.equal(res.status, 200);
    const seen = upstream.requests[upstream.requests.length - 1];
    assert.ok(sent.equals(seen.body));
    console.log("8. binary proxy round trip OK");
  }
  // 9. CONVERT_TO_TEXT / CONVERT_TO_BINARY.
  {
    const conv = async (handling, contentType, body) => {
      const draft = restDraft(upstream.url, {
        apiPublicId: `scrt0000000${Math.floor(Math.random() * 90 + 10)}`,
        resources: RESOURCES,
        method: { httpMethod: "POST" },
        integration: { type: "HTTP", uri: `${upstream.url}/echo`, contentHandling: handling },
        extra: { settings: { binaryMediaTypes: ["image/png"] } },
      });
      const artifact = { ...compileOrThrow(draft), stage: "prod" };
      const res = await runHarness(
        new Request("http://gw.test/items", { method: "POST", headers: { "content-type": contentType }, body }),
        artifact, "/items",
      );
      assert.equal(res.status, 200);
      return upstream.requests[upstream.requests.length - 1].body;
    };
    const raw = Buffer.from([1, 2, 3, 250, 251, 252]);
    const asText = await conv("CONVERT_TO_TEXT", "image/png", raw);
    assert.equal(asText.toString("utf8"), raw.toString("base64"));
    const back = await conv("CONVERT_TO_BINARY", "application/json", raw.toString("base64"));
    assert.ok(raw.equals(back));
    console.log("9. CONVERT_TO_TEXT/BINARY OK");
  }
  // 10. gzip request decompressed for MOCK template; proxy gets original.
  {
    const draft = restDraft(upstream.url, {
      apiPublicId: "scrt0000000010",
      resources: RESOURCES,
      method: { httpMethod: "POST" },
      integration: {
        type: "MOCK",
        requestTemplates: { "application/json": '{"name":$input.json(\'$.name\')}' },
      },
      extra: { settings: { minimumCompressionSize: 100 } },
    });
    const artifact = { ...compileOrThrow(draft), stage: "prod" };
    const gz = gzipSync(Buffer.from(JSON.stringify({ name: "gz" })));
    const res = await runHarness(
      new Request("http://gw.test/items", {
        method: "POST",
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
        body: gz,
      }),
      artifact, "/items",
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { name: "gz" });

    const proxyDraft = restDraft(upstream.url, {
      apiPublicId: "scrt0000000011",
      resources: RESOURCES,
      method: { httpMethod: "POST" },
      integration: { type: "HTTP_PROXY", uri: `${upstream.url}/echo` },
      extra: { settings: { minimumCompressionSize: 100 } },
    });
    const proxyArtifact = { ...compileOrThrow(proxyDraft), stage: "prod" };
    const res2 = await runHarness(
      new Request("http://gw.test/items", {
        method: "POST",
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
        body: gz,
      }),
      proxyArtifact, "/items",
    );
    assert.equal(res2.status, 200);
    const seen = upstream.requests[upstream.requests.length - 1];
    assert.ok(gz.equals(seen.body));
    console.log("10. gzip decompress + proxy-original OK");
  }
  // 11. Response compressionhere-doc free: use harness (accept gzip).
  {
    const draft = restDraft(upstream.url, {
      apiPublicId: "scrt0000000012",
      resources: RESOURCES,
      method: { httpMethod: "GET" },
      integration: { type: "HTTP_PROXY", uri: `${upstream.url}/bytes/2000` },
      extra: { settings: { minimumCompressionSize: 100 } },
    });
    const artifact = { ...compileOrThrow(draft), stage: "prod" };
    const res = await runHarness(
      new Request("http://gw.test/items", { headers: { "accept-encoding": "gzip" } }),
      artifact, "/items",
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-encoding"), "gzip");
    assert.ok(gunzipSync(Buffer.from(await res.arrayBuffer())).equals(Buffer.alloc(2000)));
    console.log("11. response compression OK");
  }
  // 12. Preflight via harness short-circuit (no OPTIONS route).
  {
    const draft = httpDraft(upstream.url, {
      apiPublicId: "scrt0000000013",
      extra: {
        settings: {
          cors: {
            allowOrigins: ["https://example.com"], allowMethods: ["GET"],
            allowHeaders: [], exposeHeaders: [], maxAge: 60, allowCredentials: false,
          },
        },
      },
    });
    const before = upstream.requests.length;
    const artifact = { ...compileOrThrow(draft), stage: "$default" };
    const res = await runHarness(
      new Request("http://gw.test/items", {
        method: "OPTIONS",
        headers: { origin: "https://example.com", "access-control-request-method": "GET" },
      }),
      artifact, "/items",
    );
    assert.equal(res.status, 204);
    assert.equal(upstream.requests.length, before);
    console.log("12. preflight short-circuit OK");
  }
  // 13. Unknown content-encoding → 415.
  {
    const draft = restDraft(upstream.url, {
      apiPublicId: "scrt0000000014",
      resources: RESOURCES,
      method: { httpMethod: "POST" },
      integration: { type: "MOCK" },
      extra: { settings: { minimumCompressionSize: 100 } },
    });
    const artifact = { ...compileOrThrow(draft), stage: "prod" };
    const res = await runHarness(
      new Request("http://gw.test/items", {
        method: "POST",
        headers: { "content-type": "application/json", "content-encoding": "br" },
        body: "{}",
      }),
      artifact, "/items",
    );
    assert.equal(res.status, 415);
    console.log("13. unknown encoding 415 OK");
  }
  console.log("ALL SCRATCH-2 CHECKS PASSED");
} finally {
  await upstream.close();
}
void http;
