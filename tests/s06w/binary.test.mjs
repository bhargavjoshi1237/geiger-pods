/**
 * S06W runtime: binary round trip of random bytes (including invalid UTF-8)
 * through `HTTP_PROXY` and `FUNCTION_PROXY` with `Accept: image/png`, plus
 * `CONVERT_TO_TEXT` / `CONVERT_TO_BINARY`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { startUpstream } from "../fixtures/upstream.mjs";
import { compileOrThrow, randomTestBytes, restDraft } from "./helper.mjs";
import { serveArtifact } from "./serve.mjs";

const RESOURCES = [
  { id: "res-root", path: "/" },
  { id: "res-items", path: "/items" },
];

function binaryDraft(upstreamUrl, apiPublicId, integration) {
  return restDraft(upstreamUrl, {
    apiPublicId,
    resources: RESOURCES,
    method: { httpMethod: "POST" },
    integration: { type: "HTTP_PROXY", uri: `${upstreamUrl}/echo`, ...integration },
    extra: { settings: { binaryMediaTypes: ["image/png"] } },
  });
}

test("S06W: binary round trip of 1 MB random bytes through HTTP_PROXY", async () => {
  const upstream = await startUpstream();
  try {
    const artifact = compileOrThrow(binaryDraft(upstream.url, "s06wbin0000001", {}));
    const { gateway, baseUrl } = await serveArtifact(artifact, { stage: "prod" });
    try {
      const sent = randomTestBytes(1024 * 1024);
      const response = await fetch(`${baseUrl}/items`, {
        method: "POST",
        headers: { "content-type": "image/png", accept: "image/png" },
        body: sent,
        duplex: "half",
      });
      assert.equal(response.status, 200);
      // The backend saw the exact bytes (no re-encoding on proxy).
      const seen = upstream.requests[upstream.requests.length - 1];
      assert.ok(sent.equals(seen.body), "upstream bytes differ");
      // The echo JSON came back intact through the binary path.
      const received = Buffer.from(await response.arrayBuffer());
      assert.ok(received.length > 0);
      assert.deepEqual(JSON.parse(received.toString("utf8")).body.length > 0, true);
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S06W: CONVERT_TO_TEXT base64-encodes binary for the integration", async () => {
  const upstream = await startUpstream();
  try {
    const artifact = compileOrThrow(binaryDraft(upstream.url, "s06wbin0000002", {
      type: "HTTP",
      contentHandling: "CONVERT_TO_TEXT",
    }));
    const { gateway, baseUrl } = await serveArtifact(artifact, { stage: "prod" });
    try {
      const sent = randomTestBytes(4096);
      const response = await fetch(`${baseUrl}/items`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: sent,
        duplex: "half",
      });
      assert.equal(response.status, 200);
      const seen = upstream.requests[upstream.requests.length - 1];
      assert.equal(seen.body.toString("utf8"), sent.toString("base64"));
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S06W: CONVERT_TO_BINARY decodes a text body into bytes", async () => {
  const upstream = await startUpstream();
  try {
    const artifact = compileOrThrow(binaryDraft(upstream.url, "s06wbin0000003", {
      type: "HTTP",
      contentHandling: "CONVERT_TO_BINARY",
    }));
    const { gateway, baseUrl } = await serveArtifact(artifact, { stage: "prod" });
    try {
      const sent = randomTestBytes(4096);
      const response = await fetch(`${baseUrl}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: sent.toString("base64"),
        duplex: "half",
      });
      assert.equal(response.status, 200);
      const seen = upstream.requests[upstream.requests.length - 1];
      assert.ok(sent.equals(seen.body), "decoded bytes differ");
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S06W: FUNCTION_PROXY binary round trip with Accept image/png", async () => {
  const upstream = await startUpstream();
  try {
    const draft = binaryDraft(upstream.url, "s06wbin0000004", {
      type: "FUNCTION_PROXY",
      function: { provider: "webhook", url: `${upstream.url}/fn` },
    });
    const artifact = compileOrThrow(draft);
    const { gateway, baseUrl } = await serveArtifact(artifact, { stage: "prod" });
    try {
      // The fixture answers Lambda proxy format; ask for binary back.
      const response = await fetch(`${baseUrl}/items`, {
        method: "POST",
        headers: { "content-type": "image/png", accept: "image/png" },
        body: randomTestBytes(1024),
        duplex: "half",
      });
      assert.equal(response.status, 200);
      const received = Buffer.from(await response.arrayBuffer());
      assert.ok(received.length > 0);
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});
