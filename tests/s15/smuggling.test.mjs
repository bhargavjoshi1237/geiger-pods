/**
 * S15 part 1 (security): HTTP request-smuggling suite.
 *
 * Raw sockets against a real `createGatewayServer`: requests carrying both
 * `Content-Length` and `Transfer-Encoding`, duplicate `Content-Length`, or a
 * malformed chunk must be rejected with 400 and the connection closed (no
 * keep-alive reuse of a desynced socket).
 */

import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { createMemoryLoader } from "../../gateway/loader.mjs";
import { createGatewayServer } from "../../gateway/server.mjs";

function mockArtifact() {
  return {
    schemaVersion: 1,
    projectId: "proj-s15",
    apiId: "api-smuggle",
    apiPublicId: "smug123456",
    protocol: "REST",
    stage: "prod",
    settings: {},
    resources: [{ id: "res-root", path: "/" }],
    methods: {},
    integrations: {},
    authorizers: {},
    models: {},
  };
}

async function startGateway() {
  const artifact = mockArtifact();
  const stages = new Map([[`${artifact.apiPublicId}:prod`, { artifact }]]);
  const loader = createMemoryLoader({ pathRouting: true, stages });
  const gateway = createGatewayServer({ loader });
  const port = await gateway.start(0);
  return { gateway, port };
}

/**
 * Sends a raw payload and resolves with `{ statusLine, closed }` where
 * `closed` is true when the server closed the TCP connection afterwards.
 */
function rawRequest(port, payload, { waitMs = 800 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(payload);
    });
    let data = "";
    let closed = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const statusLine = data.split("\r\n")[0] ?? "";
      resolve({ statusLine, closed, data });
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("close", () => {
      closed = true;
      finish();
    });
    // Swallowed: a 400 + destroy surfaces as ECONNRESET before "close";
    // only "close" (or the watchdog) settles the probe.
    socket.on("error", () => {});
    setTimeout(() => {
      try {
        socket.destroy();
      } catch {
        // Best-effort.
      }
      finish();
    }, waitMs);
  });
}

test("S15: smuggling suite (CL+TE, duplicate CL, bad chunk) rejected with 400 and connection closed", async () => {
  const { gateway, port } = await startGateway();
  try {
    // 1. Both Content-Length and Transfer-Encoding.
    const both = await rawRequest(
      port,
      "POST /smug123456/prod/ HTTP/1.1\r\n" +
        "Host: 127.0.0.1\r\n" +
        "Content-Length: 5\r\n" +
        "Transfer-Encoding: chunked\r\n" +
        "Connection: keep-alive\r\n\r\n" +
        "0\r\n\r\n",
    );
    assert.match(both.statusLine, / 400 /, `CL+TE must be 400, got: ${both.statusLine}`);
    assert.equal(both.closed, true, "CL+TE socket must be closed");

    // 2. Duplicate Content-Length.
    const dup = await rawRequest(
      port,
      "POST /smug123456/prod/ HTTP/1.1\r\n" +
        "Host: 127.0.0.1\r\n" +
        "Content-Length: 5\r\n" +
        "Content-Length: 5\r\n" +
        "Connection: keep-alive\r\n\r\n" +
        "hello",
    );
    assert.match(dup.statusLine, / 400 /, `duplicate CL must be 400, got: ${dup.statusLine}`);
    assert.equal(dup.closed, true, "duplicate-CL socket must be closed");

    // 3. Malformed chunk size.
    const badChunk = await rawRequest(
      port,
      "POST /smug123456/prod/ HTTP/1.1\r\n" +
        "Host: 127.0.0.1\r\n" +
        "Transfer-Encoding: chunked\r\n" +
        "Connection: keep-alive\r\n\r\n" +
        "ZZZ\r\nhello\r\n0\r\n\r\n",
    );
    assert.match(badChunk.statusLine, / 400 /, `bad chunk must be 400, got: ${badChunk.statusLine}`);
    assert.equal(badChunk.closed, true, "bad-chunk socket must be closed");

    // 4. A well-formed request still works afterwards (server is healthy).
    const ok = await fetch(`http://127.0.0.1:${port}/smug123456/prod/`);
    assert.ok([200, 403, 404].includes(ok.status), `healthy request, got ${ok.status}`);
    await ok.arrayBuffer().catch(() => null);
  } finally {
    await gateway.close();
  }
});

test("S15 [runtime]: Slowloris stall is closed after headersTimeout; server bounds default to spec values", async () => {
  const { GATEWAY_HEADERS_TIMEOUT_MS, GATEWAY_REQUEST_TIMEOUT_MS, GATEWAY_KEEP_ALIVE_TIMEOUT_MS } = await import(
    "../../gateway/server.mjs"
  );
  assert.equal(GATEWAY_HEADERS_TIMEOUT_MS, 60_000);
  assert.equal(GATEWAY_REQUEST_TIMEOUT_MS, 300_000);
  assert.equal(GATEWAY_KEEP_ALIVE_TIMEOUT_MS, 310_000);

  const artifact = mockArtifact();
  const stages = new Map([[`${artifact.apiPublicId}:prod`, { artifact }]]);
  const loader = createMemoryLoader({ pathRouting: true, stages });
  const gateway = createGatewayServer({ loader, http: { headersTimeout: 150, requestTimeout: 5000 } });
  assert.equal(gateway.server.headersTimeout, 150);
  const port = await gateway.start(0);
  try {
    // Send headers in drips that never complete: the server must give up and
    // close the socket instead of holding it forever.
    const stalled = await new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write("GET /smug123456/prod/ HTTP/1.1\r\nHost: 127.0.0.1\r\n");
      });
      let closed = false;
      // Note: no early resolve on "error" — a 408 + destroy surfaces as
      // ECONNRESET before "close"; only "close" (or the watchdog) decides.
      // A "data" listener keeps the socket flowing so the 408 + FIN is
      // observed promptly instead of stalling in paused mode.
      socket.on("error", () => {});
      socket.on("data", () => {});
      socket.on("close", () => {
        closed = true;
        clearTimeout(watchdog);
        resolve({ closed });
      });
      const watchdog = setTimeout(() => {
        try {
          socket.destroy();
        } catch {
          // Best-effort.
        }
        resolve({ closed });
      }, 2000);
    });
    assert.equal(stalled.closed, true, "stalled header drip must be closed after headersTimeout");
  } finally {
    await gateway.close();
  }
});
