/**
 * Shared upstream fixture (S04 §8). A `node:http` echo server every runtime
 * spec reuses. Starts on port 0: `startUpstream() → { url, close, requests[] }`.
 *
 * Routes:
 * - default: echoes `{ method, path, query, headers, body }` as JSON.
 * - `/status/{code}`: responds with that status.
 * - `/sleep/{ms}`: waits, then echoes (for timeout/abort tests).
 * - `/bytes/{n}`: exactly n zero bytes.
 * - `/stream/{chunks}`: chunked `chunk-i\n` writes, 5 ms apart (S09).
 * - `/redirect`: 302 to `/final` (gateways must not follow).
 * - `/large/{mb}`: that many megabytes of zeros.
 * - `/fn`: Lambda-format webhook; behavior via `x-fn-behavior` header or
 *   `?behavior=`: `ok-10`, `ok-20`, `ok-20-infer-object`, `ok-20-string`,
 *   `malformed`, `error-status`, default `ok-10`.
 * - `/token`: OAuth client-credentials stub; responds
 *   `{"access_token":"tok-<n>","expires_in":3600}` where n increments per call.
 * - `/auth-once`: 401 `{"message":"Unauthorized"}` on the first call, echo after
 *   (exercises the OAuth 401 refresh-and-retry).
 *
 * Every request is appended to `requests[]` as
 * `{ method, url, headers, body: Buffer, aborted }`; `aborted` flips to true
 * when the client socket closes before the response finishes.
 *
 * @module tests/fixtures/upstream
 */

import http from "node:http";

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * Starts the fixture on an ephemeral port.
 *
 * @param {{ }} [opts={}]
 * @returns {Promise<{ url: string, port: number, close(): Promise<void>, requests: Array<object> }>}
 */
export async function startUpstream(opts = {}) {
  const requests = [];
  let tokenIssued = 0;
  let authOnceHits = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://upstream.test");
    const entry = {
      method: req.method,
      url: req.url,
      path: url.pathname,
      query: url.search,
      headers: { ...req.headers },
      body: Buffer.alloc(0),
      aborted: false,
    };
    requests.push(entry);
    // `res` close (not `req` close: the request stream closes normally once
    // received) with an unfinished response means the client went away.
    res.on("close", () => {
      if (!res.writableEnded) entry.aborted = true;
    });
    entry.body = await readBody(req);

    const echo = (status = 200, extraHeaders = {}) => {
      const payload = JSON.stringify({
        method: entry.method,
        path: entry.path,
        query: entry.query,
        headers: entry.headers,
        body: entry.body.toString("utf8"),
      });
      res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
      res.end(payload);
    };

    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] === "status" && segments[1] !== undefined) {
      const code = Number(segments[1]);
      res.writeHead(Number.isInteger(code) && code >= 100 && code <= 599 ? code : 500, { "content-type": "text/plain" });
      res.end(`status ${code}`);
      return;
    }
    if (segments[0] === "sleep" && segments[1] !== undefined) {
      const ms = Math.max(0, Number(segments[1]) || 0);
      await new Promise((resolve) => setTimeout(resolve, ms));
      if (entry.aborted || req.destroyed) {
        try { res.destroy(); } catch { /* client gone */ }
        return;
      }
      echo();
      return;
    }
    if (segments[0] === "bytes" && segments[1] !== undefined) {
      const n = Math.max(0, Math.min(Number(segments[1]) || 0, 64 * 1024 * 1024));
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": n });
      res.end(Buffer.alloc(n));
      return;
    }
    if (segments[0] === "stream" && segments[1] !== undefined) {
      const chunks = Math.max(0, Math.min(Number(segments[1]) || 0, 1000));
      res.writeHead(200, { "content-type": "text/plain", "transfer-encoding": "chunked" });
      for (let index = 0; index < chunks; index += 1) {
        if (entry.aborted) break;
        res.write(`chunk-${index}\n`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      res.end();
      return;
    }
    if (segments[0] === "redirect") {
      res.writeHead(302, { location: "/final?followed=1" });
      res.end();
      return;
    }
    if (segments[0] === "large" && segments[1] !== undefined) {
      const mb = Math.max(0, Math.min(Number(segments[1]) || 0, 64));
      const total = mb * 1024 * 1024;
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": total });
      const chunk = Buffer.alloc(64 * 1024);
      let sent = 0;
      while (sent < total && !entry.aborted) {
        const end = Math.min(total, sent + chunk.byteLength);
        res.write(chunk.subarray(0, end - sent));
        sent = end;
      }
      res.end();
      return;
    }
    if (segments[0] === "fn") {
      const behavior = req.headers["x-fn-behavior"] ?? url.searchParams.get("behavior") ?? "ok-10";
      if (behavior === "error-status") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ errorMessage: "boom" }));
        return;
      }
      if (behavior === "malformed") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{not json");
        return;
      }
      if (behavior === "ok-20" || behavior === "ok-20-infer-object" || behavior === "ok-20-string") {
        res.writeHead(200, { "content-type": "application/json" });
        if (behavior === "ok-20-infer-object") {
          res.end(JSON.stringify({ hello: "world" }));
          return;
        }
        if (behavior === "ok-20-string") {
          res.end(JSON.stringify("just a string"));
          return;
        }
        res.end(JSON.stringify({ statusCode: 201, headers: { "x-fn": "yes", "set-cookie": "a=1" }, cookies: ["a=1", "b=2"], body: "created" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        statusCode: 200,
        headers: { "x-fn": "one" },
        multiValueHeaders: { "x-multi": ["a", "b"] },
        body: JSON.stringify({ echoed: true, signature: req.headers["x-pods-signature"] ?? null }),
        isBase64Encoded: false,
      }));
      return;
    }
    if (segments[0] === "token") {
      tokenIssued += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: `tok-${tokenIssued}`, token_type: "Bearer", expires_in: 3600 }));
      return;
    }
    if (segments[0] === "auth-once") {
      authOnceHits += 1;
      if (authOnceHits === 1) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Unauthorized" }));
        return;
      }
      echo();
      return;
    }
    echo();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
