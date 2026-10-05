/**
 * S06W runtime: gzip request bodies decompressed for templates; responses at
 * or above the threshold compressed only with `Accept-Encoding: gzip`;
 * below-threshold responses untouched; unknown encodings → 415.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { startUpstream } from "../fixtures/upstream.mjs";
import { compileOrThrow, restDraft } from "./helper.mjs";
import { serveArtifact } from "./serve.mjs";

const RESOURCES = [
  { id: "res-root", path: "/" },
  { id: "res-items", path: "/items" },
];

function compressedDraft(upstreamUrl, apiPublicId, integration) {
  return restDraft(upstreamUrl, {
    apiPublicId,
    resources: RESOURCES,
    method: { httpMethod: "POST" },
    integration: { type: "MOCK", ...integration },
    extra: { settings: { minimumCompressionSize: 100 } },
  });
}

/**
 * Raw HTTP request (no automatic decompression, unlike fetch).
 *
 * @param {string} url
 * @param {object} [options={}]
 * @returns {Promise<{ status: number, headers: object, body: Buffer }>}
 */
function rawRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }));
      },
    );
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

test("S06W: gzip request body decompressed for templates", async () => {
  const upstream = await startUpstream();
  try {
    const draft = compressedDraft(upstream.url, "s06wzip0000001", {
      requestTemplates: { "application/json": '{"name":$input.json(\'$.name\')}' },
    });
    const artifact = compileOrThrow(draft);
    const { gateway, baseUrl } = await serveArtifact(artifact, { stage: "prod" });
    try {
      const raw = Buffer.from(JSON.stringify({ name: "gz" }));
      const result = await rawRequest(`${baseUrl}/items`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
        body: gzipSync(raw),
      });
      assert.equal(result.status, 200);
      // The template evaluated against the decompressed body.
      assert.deepEqual(JSON.parse(result.body.toString("utf8")), { name: "gz" });
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S06W: proxy receives the original encoded body plus header", async () => {
  const upstream = await startUpstream();
  try {
    const draft = restDraft(upstream.url, {
      apiPublicId: "s06wzip0000002",
      resources: RESOURCES,
      method: { httpMethod: "POST" },
      integration: { type: "HTTP_PROXY", uri: `${upstream.url}/echo` },
      extra: { settings: { minimumCompressionSize: 100 } },
    });
    const artifact = compileOrThrow(draft);
    const { gateway, baseUrl } = await serveArtifact(artifact, { stage: "prod" });
    try {
      const raw = Buffer.from(JSON.stringify({ name: "raw" }));
      const gzipped = gzipSync(raw);
      const result = await rawRequest(`${baseUrl}/items`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
        body: gzipped,
      });
      assert.equal(result.status, 200);
      const seen = upstream.requests[upstream.requests.length - 1];
      assert.ok(gzipped.equals(seen.body), "proxy must get the original encoded bytes");
      assert.equal(seen.headers["content-encoding"], "gzip");
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S06W: response at/above threshold compressed only with Accept-Encoding gzip", async () => {
  const upstream = await startUpstream();
  try {
    const draft = restDraft(upstream.url, {
      apiPublicId: "s06wzip0000003",
      resources: RESOURCES,
      method: { httpMethod: "GET" },
      integration: { type: "HTTP_PROXY", uri: `${upstream.url}/bytes/2000` },
      extra: { settings: { minimumCompressionSize: 100 } },
    });
    const artifact = compileOrThrow(draft);
    const { gateway, baseUrl } = await serveArtifact(artifact, { stage: "prod" });
    try {
      const gz = await rawRequest(`${baseUrl}/items`, {
        headers: { "accept-encoding": "gzip" },
      });
      assert.equal(gz.status, 200);
      assert.equal(gz.headers["content-encoding"], "gzip");
      assert.ok(gz.headers.vary?.toLowerCase().includes("accept-encoding"));
      assert.ok(gunzipSync(gz.body).equals(Buffer.alloc(2000)));

      // Without Accept-Encoding: identity.
      const plain = await rawRequest(`${baseUrl}/items`);
      assert.equal(plain.status, 200);
      assert.equal(plain.headers["content-encoding"], undefined);
      assert.ok(plain.body.equals(Buffer.alloc(2000)));
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S06W: response below threshold is not compressed", async () => {
  const upstream = await startUpstream();
  try {
    const draft = restDraft(upstream.url, {
      apiPublicId: "s06wzip0000004",
      resources: RESOURCES,
      method: { httpMethod: "GET" },
      integration: { type: "HTTP_PROXY", uri: `${upstream.url}/bytes/10` },
      extra: { settings: { minimumCompressionSize: 100 } },
    });
    const artifact = compileOrThrow(draft);
    const { gateway, baseUrl } = await serveArtifact(artifact, { stage: "prod" });
    try {
      const result = await rawRequest(`${baseUrl}/items`, {
        headers: { "accept-encoding": "gzip" },
      });
      assert.equal(result.status, 200);
      assert.equal(result.headers["content-encoding"], undefined);
      assert.ok(result.body.equals(Buffer.alloc(10)));
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S06W: unknown request content-encoding → 415", async () => {
  const upstream = await startUpstream();
  try {
    const draft = compressedDraft(upstream.url, "s06wzip0000005", {});
    const artifact = compileOrThrow(draft);
    const { gateway, baseUrl } = await serveArtifact(artifact, { stage: "prod" });
    try {
      const result = await rawRequest(`${baseUrl}/items`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-encoding": "br" },
        body: Buffer.from("{}"),
      });
      assert.equal(result.status, 415);
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});
