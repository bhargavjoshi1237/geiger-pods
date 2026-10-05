/**
 * S06W runtime: HTTP preflight answered 204 without calling authorizer or
 * integration; backend CORS headers replaced; `*` + credentials rejected
 * (compile, covered in `compile.test.mjs`).
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { startUpstream } from "../fixtures/upstream.mjs";
import { compileOrThrow, httpDraft } from "./helper.mjs";
import { serveArtifact } from "./serve.mjs";

const CORS = {
  allowOrigins: ["https://example.com"],
  allowMethods: ["GET", "POST"],
  allowHeaders: ["Content-Type", "Authorization"],
  exposeHeaders: ["X-Trace"],
  maxAge: 600,
  allowCredentials: true,
};

function corsDraft(upstreamUrl, apiPublicId) {
  return httpDraft(upstreamUrl, {
    apiPublicId,
    extra: { settings: { cors: CORS } },
  });
}

test("S06W: HTTP preflight answered 204 without calling authorizer or integration", async () => {
  const upstream = await startUpstream();
  try {
    const artifact = compileOrThrow(corsDraft(upstream.url, "s06wpreflight1"));
    const { gateway, baseUrl } = await serveArtifact(artifact);
    try {
      const before = upstream.requests.length;
      const response = await fetch(`${baseUrl}/items`, {
        method: "OPTIONS",
        headers: {
          origin: "https://example.com",
          "access-control-request-method": "GET",
        },
      });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get("access-control-allow-origin"), "https://example.com");
      assert.ok((response.headers.get("access-control-allow-methods") ?? "").includes("GET"));
      assert.equal(response.headers.get("access-control-allow-credentials"), "true");
      assert.equal(response.headers.get("access-control-max-age"), "600");
      // No integration call (and no OPTIONS route exists, so routing alone
      // would 404 — the preflight short-circuits before match/auth/invoke).
      assert.equal(upstream.requests.length, before);
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S06W: disallowed origin preflight has no CORS headers; request still proceeds", async () => {
  const upstream = await startUpstream();
  try {
    const artifact = compileOrThrow(corsDraft(upstream.url, "s06wpreflight2"));
    const { gateway, baseUrl } = await serveArtifact(artifact);
    try {
      const preflight = await fetch(`${baseUrl}/items`, {
        method: "OPTIONS",
        headers: {
          origin: "https://evil.test",
          "access-control-request-method": "GET",
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), null);

      // The actual request proceeds (browsers enforce CORS, not the gateway).
      const actual = await fetch(`${baseUrl}/items`, {
        headers: { origin: "https://evil.test" },
      });
      assert.equal(actual.status, 200);
      assert.equal(actual.headers.get("access-control-allow-origin"), null);
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S06W: non-preflight OPTIONS goes through normal routing", async () => {
  const upstream = await startUpstream();
  try {
    const artifact = compileOrThrow(corsDraft(upstream.url, "s06wpreflight3"));
    const { gateway, baseUrl } = await serveArtifact(artifact);
    try {
      // OPTIONS without Access-Control-Request-Method is not a preflight;
      // no OPTIONS route exists → HTTP 404.
      const response = await fetch(`${baseUrl}/items`, { method: "OPTIONS" });
      assert.equal(response.status, 404);
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S06W: backend CORS headers replaced by the configured ones", async () => {
  // Inline backend that always emits its own CORS headers (the fixture echo
  // server cannot inject response headers, and S04 owns that file).
  const backend = http.createServer((req, res) => {
    let size = 0;
    req.on("data", (chunk) => { size += chunk.length; });
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": "https://backend.internal",
        "access-control-expose-headers": "X-Backend",
      });
      res.end(JSON.stringify({ ok: true, size }));
    });
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const backendUrl = `http://127.0.0.1:${backend.address().port}`;
  const upstream = await startUpstream();
  try {
    const artifact = compileOrThrow(corsDraft(backendUrl, "s06wpreflight4"));
    const { gateway, baseUrl } = await serveArtifact(artifact);
    try {
      const response = await fetch(`${baseUrl}/items`, {
        headers: { origin: "https://example.com" },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), "https://example.com");
      assert.equal(response.headers.get("access-control-expose-headers"), "X-Trace");
      assert.equal(response.headers.get("vary")?.toLowerCase().includes("origin"), true);
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
    await new Promise((resolve) => backend.close(resolve));
  }
});
