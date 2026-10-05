/**
 * S06W runtime: integration response selected by status regex, function
 * `errorMessage` regex, default fallback, and missing-default 500.
 * (Undeclared method responses fail at compile — see `compile.test.mjs`.)
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

function selectionDraft(upstreamUrl, apiPublicId, uri, integrationResponses, statusCodes) {
  return restDraft(upstreamUrl, {
    apiPublicId,
    resources: RESOURCES,
    method: {
      methodResponses: statusCodes.map((statusCode) => ({
        statusCode, responseParameters: {}, responseModels: {},
      })),
    },
    integration: {
      type: "HTTP",
      uri,
      integrationResponses,
    },
  });
}

test("S06W: integration response selected by backend status regex", async () => {
  const upstream = await startUpstream();
  try {
    const draft = selectionDraft(
      upstream.url,
      "s06wsel0000001",
      `${upstream.url}/status/201`,
      [
        {
          statusCode: "200",
          selectionPattern: "2..",
          responseParameters: { "method.response.header.X-Sel": "'regex-hit'" },
          responseTemplates: { "application/json": '{"picked":"regex"}' },
        },
        {
          statusCode: "500",
          selectionPattern: "",
          responseParameters: {},
          responseTemplates: {},
        },
      ],
      ["200", "500"],
    );
    const artifact = compileOrThrow(draft);
    const { gateway, baseUrl } = await serveArtifact(artifact, { stage: "prod" });
    try {
      const response = await fetch(`${baseUrl}/items`, { headers: { accept: "application/json" } });
      // Backend returned 201; the "2.." pattern selects the 200 row.
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-sel"), "regex-hit");
      assert.deepEqual(await response.json(), { picked: "regex" });
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S06W: default integration response used when no pattern matches", async () => {
  const upstream = await startUpstream();
  try {
    const draft = selectionDraft(
      upstream.url,
      "s06wsel0000002",
      `${upstream.url}/status/201`,
      [
        {
          statusCode: "500",
          selectionPattern: "5..",
          responseParameters: {},
          responseTemplates: {},
        },
        {
          statusCode: "200",
          selectionPattern: "",
          responseParameters: {},
          responseTemplates: {},
        },
      ],
      ["200", "500"],
    );
    const artifact = compileOrThrow(draft);
    const { gateway, baseUrl } = await serveArtifact(artifact, { stage: "prod" });
    try {
      const response = await fetch(`${baseUrl}/items`);
      assert.equal(response.status, 200);
      // Passthrough: the backend echo body is unchanged.
      const body = await response.json();
      assert.equal(body.path, "/status/201");
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S06W: no matching pattern and no default → 500 API_CONFIGURATION_ERROR", async () => {
  const upstream = await startUpstream();
  try {
    const draft = selectionDraft(
      upstream.url,
      "s06wsel0000003",
      `${upstream.url}/status/200`,
      [{
        statusCode: "500",
        selectionPattern: "5..",
        responseParameters: {},
        responseTemplates: {},
      }],
      ["500"],
    );
    const artifact = compileOrThrow(draft);
    const { gateway, baseUrl } = await serveArtifact(artifact, { stage: "prod" });
    try {
      const response = await fetch(`${baseUrl}/items`);
      assert.equal(response.status, 500);
      assert.equal(response.headers.get("x-pods-error-type"), "API_CONFIGURATION_ERROR");
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S06W: FUNCTION errorMessage regex selects the integration response", async () => {
  const upstream = await startUpstream();
  try {
    const draft = restDraft(upstream.url, {
      apiPublicId: "s06wsel0000004",
      resources: RESOURCES,
      method: {
        methodResponses: [{ statusCode: "200", responseParameters: {}, responseModels: {} }],
      },
      integration: {
        type: "FUNCTION",
        function: { provider: "webhook", url: `${upstream.url}/fn?behavior=error-status` },
        integrationResponses: [{
          statusCode: "200",
          selectionPattern: ".*boom.*",
          responseParameters: {},
          responseTemplates: { "application/json": '{"caught":true}' },
        }],
      },
    });
    const artifact = compileOrThrow(draft);
    const { gateway, baseUrl } = await serveArtifact(artifact, { stage: "prod" });
    try {
      const response = await fetch(`${baseUrl}/items`, { headers: { accept: "application/json" } });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { caught: true });
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});
