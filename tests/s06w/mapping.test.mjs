/**
 * S06W runtime: HTTP parameter mapping (append/overwrite/remove for header
 * and querystring, `overwrite:path`, response `overwrite:statuscode`),
 * `${…}` interpolation and the 100 KB `$request.body` truncation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { startUpstream } from "../fixtures/upstream.mjs";
import { compileOrThrow, httpDraft } from "./helper.mjs";
import { serveArtifact } from "./serve.mjs";

function mappingDraft(upstreamUrl, apiPublicId, requestMapping, responseMappings = null) {
  return httpDraft(upstreamUrl, {
    apiPublicId,
    route: { routeKey: "GET /users/{name}/posts/{id}" },
    integration: {
      // NOTE: HTTP APIs support HTTP_PROXY integrations; the AWS HTTP
      // parameter-mapping grammar applies to them.
      type: "HTTP_PROXY",
      uri: `${upstreamUrl}/echo`,
      requestMapping,
      ...(responseMappings ? { responseMappings } : {}),
    },
  });
}

test("S06W: HTTP mapping append/overwrite/remove for header and querystring; overwrite:path", async () => {
  const upstream = await startUpstream();
  try {
    const artifact = compileOrThrow(mappingDraft(upstream.url, "s06wmap0000001", {
      "overwrite:header.x-over": "static-value",
      "append:header.x-multi": "$request.header.x-src",
      "remove:header.x-drop": "ignored",
      "overwrite:querystring.q": "$request.querystring.a",
      "append:querystring.q2": "b",
      "remove:querystring.drop": "ignored",
      "overwrite:path": "/fixed",
    }));
    const { gateway, baseUrl } = await serveArtifact(artifact);
    try {
      const response = await fetch(`${baseUrl}/users/alice/posts/42?a=1&drop=yes`, {
        headers: { "x-src": "s", "x-drop": "gone" },
      });
      assert.equal(response.status, 200);
      const seen = upstream.requests[upstream.requests.length - 1];
      // overwrite:path replaces the backend path entirely.
      assert.equal(seen.path, "/fixed");
      // Header ops (lowercased by the echo fixture).
      assert.equal(seen.headers["x-over"], "static-value");
      assert.equal(seen.headers["x-multi"], "s");
      assert.equal(seen.headers["x-drop"], undefined);
      // Query ops.
      const query = new URL(`http://x${seen.query}`);
      assert.equal(query.searchParams.get("q"), "1");
      assert.equal(query.searchParams.get("q2"), "b");
      assert.equal(query.searchParams.get("drop"), null);
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S06W: response overwrite:statuscode maps backend 500 to 403", async () => {
  const upstream = await startUpstream();
  try {
    const draft = httpDraft(upstream.url, {
      apiPublicId: "s06wmap0000002",
      integration: {
        type: "HTTP_PROXY",
        uri: `${upstream.url}/status/500`,
        responseMappings: { 500: { "overwrite:statuscode": "403" } },
      },
    });
    const artifact = compileOrThrow(draft);
    const { gateway, baseUrl } = await serveArtifact(artifact);
    try {
      const response = await fetch(`${baseUrl}/items`);
      assert.equal(response.status, 403);
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S06W: ${request.path.name} ${request.path.id} interpolation", async () => {
  const upstream = await startUpstream();
  try {
    const artifact = compileOrThrow(mappingDraft(upstream.url, "s06wmap0000003", {
      "overwrite:header.x-combo": "${request.path.name} ${request.path.id}",
    }));
    const { gateway, baseUrl } = await serveArtifact(artifact);
    try {
      const response = await fetch(`${baseUrl}/users/alice/posts/42`);
      assert.equal(response.status, 200);
      const seen = upstream.requests[upstream.requests.length - 1];
      assert.equal(seen.headers["x-combo"], "alice 42");
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S06W: $request.body truncated at 100 KB before evaluation", async () => {
  const upstream = await startUpstream();
  try {
    const draft = httpDraft(upstream.url, {
      apiPublicId: "s06wmap0000004",
      route: { routeKey: "POST /users/{name}/posts/{id}" },
      integration: {
        type: "HTTP_PROXY",
        uri: `${upstream.url}/echo`,
        requestMapping: {
          "overwrite:header.x-early": "$request.body.early",
          "overwrite:header.x-deep": "$request.body.deep.value",
        },
      },
    });
    const artifact = compileOrThrow(draft);
    const { gateway, baseUrl } = await serveArtifact(artifact);
    try {
      const body = JSON.stringify({
        early: "yes",
        pad: "x".repeat(110 * 1024),
        deep: { value: "beyond-cutoff" },
      });
      const response = await fetch(`${baseUrl}/users/alice/posts/42`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      assert.equal(response.status, 200);
      const seen = upstream.requests[upstream.requests.length - 1];
      // The 100 KB truncation cuts inside `pad`, so the truncated prefix no
      // longer parses as JSON (see S06 pure truncation test): every
      // `$request.body.*` source resolves to "" rather than reading
      // unbounded input.
      assert.equal(seen.headers["x-early"], "");
      assert.equal(seen.headers["x-deep"], "");
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});
