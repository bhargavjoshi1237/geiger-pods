/**
 * S06W runtime: VTL request/response templates on HTTP-custom and MOCK
 * integrations (representative AWS-docs patterns end to end — the full 40+
 * golden suite lives in the S06 pure tests), plus template limit and
 * passthrough behavior over the wire.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { startUpstream } from "../fixtures/upstream.mjs";
import { compileOrThrow, restDraft } from "./helper.mjs";
import { serveArtifact } from "./serve.mjs";

const RESOURCES = [
  { id: "res-root", path: "/" },
  { id: "res-items", path: "/items" },
];

test("S06W: VTL request template transforms on HTTP custom; response template + responseOverride win", async () => {
  const upstream = await startUpstream();
  try {
    const draft = restDraft(upstream.url, {
      apiPublicId: "s06wvtl000001",
      resources: RESOURCES,
      method: {
        httpMethod: "POST",
        methodResponses: [{ statusCode: "201", responseParameters: {}, responseModels: {} }],
      },
      integration: {
        type: "HTTP",
        uri: `${upstream.url}/echo`,
        requestTemplates: {
          // foreach with hasNext commas, $input.json, $util.escapeJavaScript,
          // $input.params and a requestOverride header.
          "application/json": [
            "#set($list = $input.path('$.items'))",
            '{"statusCode":200,"joined":"#foreach($i in $list)$i#if($foreach.hasNext),#end#end",',
            '"first":$input.json(\'$.items[0]\'),"safe":"$util.escapeJavaScript($input.path(\'$.name\'))",',
            '"q":"$input.params(\'q\')"}',
            "#set($context.requestOverride.header[\"X-From-Template\"] = \"yes\")",
          ].join(""),
        },
        integrationResponses: [{
          statusCode: "201",
          selectionPattern: "",
          responseParameters: {},
          // responseOverride status/header win over the selected 201/params.
          responseTemplates: {
            "application/json": [
              "#set($context.responseOverride.status = 202)",
              "#set($context.responseOverride.header[\"X-Resp\"] = \"r1\")",
              '{"ok":true}',
            ].join(""),
          },
        }],
      },
    });
    const artifact = compileOrThrow(draft);
    const { gateway, baseUrl } = await serveArtifact(artifact, { stage: "prod" });
    try {
      const response = await fetch(`${baseUrl}/items?q=7`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: ["a", "b", "c"], name: 'x"y' }),
      });
      // responseOverride.status replaces the selected 201.
      assert.equal(response.status, 202);
      assert.equal(response.headers.get("x-resp"), "r1");
      assert.deepEqual(await response.json(), { ok: true });

      // The requestOverride header reached the backend; the template saw the
      // decoded body (foreach/escape/params all evaluated server-side).
      const seen = upstream.requests[upstream.requests.length - 1];
      assert.equal(seen.headers["x-from-template"], "yes");
      const sent = JSON.parse(seen.body.toString("utf8"));
      assert.equal(sent.joined, "a,b,c");
      assert.equal(sent.first, "a");
      assert.equal(sent.safe, 'x\\"y');
      assert.equal(sent.q, "7");
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S06W: VTL request/response templates on MOCK with statusCode selection", async () => {
  const upstream = await startUpstream();
  try {
    const draft = restDraft(upstream.url, {
      apiPublicId: "s06wvtl000002",
      resources: RESOURCES,
      method: {
        httpMethod: "POST",
        methodResponses: [
          { statusCode: "200", responseParameters: {}, responseModels: {} },
          { statusCode: "201", responseParameters: {}, responseModels: {} },
        ],
      },
      integration: {
        type: "MOCK",
        requestTemplates: {
          "application/json": '{"statusCode": 201, "made": $input.json(\'$.n\')}',
        },
        integrationResponses: [
          {
            statusCode: "201",
            selectionPattern: "",
            responseParameters: {},
            responseTemplates: { "application/json": '{"made":$input.json(\'$.made\')}' },
          },
          {
            statusCode: "200",
            selectionPattern: "",
            responseParameters: {},
            responseTemplates: {},
          },
        ],
      },
    });
    // Two defaults would both match-any; keep only the 201 default for this run.
    draft.integrations[0].integrationResponses = [draft.integrations[0].integrationResponses[0]];
    const artifact = compileOrThrow(draft);
    const { gateway, baseUrl } = await serveArtifact(artifact, { stage: "prod" });
    try {
      const response = await fetch(`${baseUrl}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ n: 41 }),
      });
      // MOCK selects by the rendered request template statusCode (201).
      assert.equal(response.status, 201);
      assert.deepEqual(await response.json(), { made: 41 });
      // No backend call for MOCK integrations.
      assert.equal(upstream.requests.length, 0);
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S06W: template foreach >1000 iterations → 500 API_CONFIGURATION_ERROR", async () => {
  const upstream = await startUpstream();
  try {
    const draft = restDraft(upstream.url, {
      apiPublicId: "s06wvtl000003",
      resources: RESOURCES,
      method: { httpMethod: "POST" },
      integration: {
        type: "MOCK",
        requestTemplates: {
          "application/json": "#foreach($i in [1..2000])$i#end",
        },
      },
    });
    const artifact = compileOrThrow(draft);
    const { gateway, baseUrl } = await serveArtifact(artifact, { stage: "prod" });
    try {
      const response = await fetch(`${baseUrl}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 500);
      assert.equal(response.headers.get("x-pods-error-type"), "API_CONFIGURATION_ERROR");
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S06W: passthrough WHEN_NO_TEMPLATES/NEVER produce passthrough/415", async () => {
  const upstream = await startUpstream();
  try {
    // WHEN_NO_TEMPLATES with templates defined but no match → 415.
    const strict = restDraft(upstream.url, {
      apiPublicId: "s06wvtl000004",
      resources: RESOURCES,
      method: { httpMethod: "POST" },
      integration: {
        type: "MOCK",
        passthroughBehavior: "WHEN_NO_TEMPLATES",
        requestTemplates: { "application/xml": "<ok/>" },
      },
    });
    const strictArtifact = compileOrThrow(strict);
    const first = await serveArtifact(strictArtifact, { stage: "prod" });
    try {
      const response = await fetch(`${first.baseUrl}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 415);
      assert.equal(response.headers.get("x-pods-error-type"), "UNSUPPORTED_MEDIA_TYPE");
    } finally {
      await first.gateway.close();
    }

    // WHEN_NO_MATCH passes the body through unchanged (MOCK ignores it, 200).
    const loose = restDraft(upstream.url, {
      apiPublicId: "s06wvtl000005",
      resources: RESOURCES,
      method: { httpMethod: "POST" },
      integration: {
        type: "MOCK",
        passthroughBehavior: "WHEN_NO_MATCH",
        requestTemplates: { "application/xml": "<ok/>" },
      },
    });
    const looseArtifact = compileOrThrow(loose);
    const second = await serveArtifact(looseArtifact, { stage: "prod" });
    try {
      const response = await fetch(`${second.baseUrl}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 200);
    } finally {
      await second.gateway.close();
    }
  } finally {
    await upstream.close();
  }
});
