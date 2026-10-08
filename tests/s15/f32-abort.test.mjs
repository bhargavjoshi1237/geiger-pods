/**
 * F32 (S15 part 2): real-socket abort teardown.
 *
 * Aborting `invokeHttp` mid-body (client disconnect) must not leave orphan
 * undici sockets: the owned dispatcher is closed on every path and the
 * upstream sees the connection drop. Uses real `node:http` + real undici
 * (loopback allowed via the integration flag), no stubs on the data path.
 */

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";

import { invokeHttp } from "../../lib/gateway/core/integrations/http.mjs";

function ctxFor(url, signal) {
  return {
    request: new Request(url, { method: "GET", headers: new Headers() }),
    artifact: { protocol: "REST" },
    context: { identity: {} },
    signal,
    pathParams: {},
    greedyParams: [],
    stageVariables: {},
    requestPathParams: {},
  };
}

test("F32: aborting mid-body frees the real socket (no orphan dispatcher)", async (t) => {
  // Slow upstream: streams 256 × 4 KB chunks with a delay, so the client can
  // abort mid-body over a real socket.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    let sent = 0;
    const timer = setInterval(() => {
      if (res.destroyed) {
        clearInterval(timer);
        return;
      }
      sent += 1;
      res.write(Buffer.alloc(4096, 1));
      if (sent >= 256) {
        clearInterval(timer);
        res.end();
      }
    }, 5);
    req.on("close", () => clearInterval(timer));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const target = `http://127.0.0.1:${port}/slow`;

  const controller = new AbortController();
  const ctx = ctxFor(target, controller.signal);
  const integration = {
    uri: target,
    integration_method: "GET",
    timeout_ms: 30000,
    allowLoopback: true,
  };
  const outbound = { method: "GET", url: target, headers: new Headers(), body: null };
  const ports = { log: () => {} };

  const pending = invokeHttp(ctx, integration, outbound, ports);
  // Let the first bytes arrive, then abort like a client disconnect.
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort(new Error("client-abort"));
  await assert.rejects(pending, (error) => {
    assert.equal(error?.type, "INTEGRATION_TIMEOUT");
    assert.equal(error?.clientAborted, true);
    return true;
  });

  // The upstream socket must be gone (no orphan): polling the server's open
  // connections drops to zero shortly after the abort + dispatcher close.
  let connections = -1;
  for (let index = 0; index < 40; index += 1) {
    connections = await new Promise((resolve, reject) => {
      server.getConnections((error, count) => (error ? reject(error) : resolve(count)));
    });
    if (connections === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(connections, 0, "upstream must see zero open connections after abort");

  // The pool is usable afterwards (a fresh request succeeds — no exhaustion).
  const ctx2 = ctxFor(target, null);
  // Ask for a fast single-chunk response instead: reuse the same server with
  // a short timeout; the point is the second invoke gets a socket at all.
  const quick = await invokeHttp(
    ctx2,
    { ...integration, timeout_ms: 15000 },
    outbound,
    ports,
  );
  assert.equal(quick.status, 200);
  assert.ok(quick.body.byteLength > 0);
});
