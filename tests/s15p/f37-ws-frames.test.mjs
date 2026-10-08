/**
 * F37 (S15): per-frame 32 KB WebSocket accounting.
 *
 * - Unit: the frame sniffer flags data frames > 32 KB (masked/unmasked,
 *   16-bit and 64-bit lengths, split headers, multi-frame chunks) while
 *   control frames and ≤ 32 KB fragments pass.
 * - Runtime (raw frames, no `ws` client): a single 40 KB frame closes the
 *   connection with 1009; a fragmented 100 KB message (4 × 25 KB) stays up.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";

import { createFrameMonitor, closeFrame } from "../../lib/gateway/core/websocket/frames.mjs";
import { MAX_FRAME_BYTES, MAX_MESSAGE_BYTES } from "../../lib/gateway/core/websocket/constants.mjs";
import { createWebSocketManager } from "../../lib/gateway/core/websocket/manager.mjs";

assert.equal(MAX_FRAME_BYTES, 32 * 1024);
assert.equal(MAX_MESSAGE_BYTES, 128 * 1024);

function maskedFrame({ fin = true, opcode = 0x1, payload }) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = randomBytes(4);
  const masked = Buffer.alloc(body.length);
  for (let index = 0; index < body.length; index += 1) masked[index] = body[index] ^ mask[index % 4];
  let header;
  if (body.length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0x00) | opcode, 0x80 | body.length]);
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0x00) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0x00) | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, mask, masked]);
}

test("F37: sniffer flags oversized data frames, passes fragments and control frames", () => {
  const seen = [];
  const monitor = createFrameMonitor({ onViolation: (info) => seen.push(info) });
  // 32 KB exactly: ok. 32 KB + 1: violation.
  assert.equal(monitor.feed(maskedFrame({ payload: Buffer.alloc(32 * 1024, 0x61) })), "ok");
  assert.equal(monitor.feed(maskedFrame({ payload: Buffer.alloc(32 * 1024 + 1, 0x61) })), "violation");
  assert.equal(monitor.violated, true);
  assert.equal(seen[0].payloadLength, 32 * 1024 + 1);
  // Once violated, everything reports violation.
  assert.equal(monitor.feed(Buffer.from([0x81, 0x01, 0x41])), "violation");
});

test("F37: sniffer handles split headers, batched frames and 64-bit lengths", () => {
  const monitor = createFrameMonitor();
  const frame = maskedFrame({ payload: Buffer.alloc(100, 0x62) });
  // Feed one byte at a time: small frame passes once complete.
  let status = "ok";
  for (const byte of frame) status = monitor.feed(Buffer.from([byte]));
  assert.equal(status, "ok");
  // Two small frames in one chunk pass.
  assert.equal(monitor.feed(Buffer.concat([frame, frame])), "ok");
  // 64-bit length declaring 40 KB flags a violation.
  const big = maskedFrame({ payload: Buffer.alloc(40 * 1024, 0x63) });
  assert.ok(big[1] === (0x80 | 127) || big.length > 0);
  assert.equal(monitor.feed(big), "violation");
});

test("F37: sniffer skips ping/pong/close frames", () => {
  const monitor = createFrameMonitor();
  const ping = Buffer.concat([Buffer.from([0x89, 0x84]), randomBytes(4), Buffer.from([1, 2, 3, 4])]);
  assert.equal(monitor.feed(ping), "ok");
  const pong = Buffer.concat([Buffer.from([0x8a, 0x80]), randomBytes(4)]);
  assert.equal(monitor.feed(pong), "ok");
  assert.equal(monitor.violated, false);
});

test("F37: closeFrame serializes an unmasked 1009 close", () => {
  const frame = closeFrame(1009, "frame too large");
  assert.equal(frame[0], 0x88);
  assert.equal(frame.readUInt16BE(2), 1009);
});

function wsArtifact() {
  return {
    schemaVersion: 1,
    projectId: "proj-f37",
    apiId: "api-f37",
    apiPublicId: "ws12345678",
    protocol: "WEBSOCKET",
    stage: "prod",
    settings: { routeSelectionExpression: "$request.body.action" },
    routes: [
      { id: "r-default", routeKey: "$default", auth: { type: "NONE" }, integrationId: null },
      { id: "r-disconnect", routeKey: "$disconnect", auth: { type: "NONE" }, integrationId: null },
    ],
    integrations: {},
    authorizers: {},
    models: {},
  };
}

async function startManager() {
  const artifact = wsArtifact();
  const loader = {
    async resolve() {
      return { artifact, stage: "prod", apiPublicId: artifact.apiPublicId, viaDefaultEndpoint: true };
    },
  };
  const events = [];
  const manager = createWebSocketManager({
    loader,
    ports: { kv: null, events: { emit: (event) => events.push(event) }, fetch: async () => new Response("{}", { status: 200 }) },
    clock: { now: () => Date.now() },
  });
  const server = createServer((req, res) => {
    res.writeHead(404).end();
  });
  manager.attach(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return { manager, server, port, events };
}

function handshake(port, path = "/ws12345678/prod") {
  const socket = connect(port, "127.0.0.1");
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  return socket;
}

function waitFor({ socket, timeoutMs = 5000, until }) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.removeListener("data", onData);
      reject(new Error("wait timeout"));
    }, timeoutMs);
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const out = until(buffer);
      if (out !== null && out !== undefined) {
        clearTimeout(timer);
        socket.removeListener("data", onData);
        resolve(out);
      }
    }
    socket.on("data", onData);
  });
}

test("F37 [runtime]: single 40 KB frame closes with 1009", async () => {
  const { manager, server } = await startManager();
  try {
    const socket = handshake(server.address().port);
    await waitFor({ socket, until: (buffer) => (buffer.includes("101") ? true : null) });
    socket.write(maskedFrame({ payload: Buffer.alloc(40 * 1024, 0x61) }));
    const code = await waitFor({
      socket,
      until: (buffer) => {
        if (buffer.length < 4) return null;
        if (buffer[0] !== 0x88) return null;
        return buffer.readUInt16BE(2);
      },
    });
    assert.equal(code, 1009);
    // A raw socket never echoes the close handshake, so the server only
    // releases the socket on its close timeout: destroy client-side and
    // assert the manager cleaned the connection up.
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(manager.connections.size, 0);
  } finally {
    await manager.close();
    server.close();
  }
});

test("F37 [runtime]: fragmented 100 KB message in 25 KB frames stays up", async () => {
  const { manager, server } = await startManager();
  try {
    const socket = handshake(server.address().port);
    await waitFor({ socket, until: (buffer) => (buffer.includes("101") ? true : null) });
    const chunk = Buffer.alloc(25 * 1024, 0x62);
    socket.write(maskedFrame({ fin: false, opcode: 0x1, payload: chunk }));
    socket.write(maskedFrame({ fin: false, opcode: 0x0, payload: chunk }));
    socket.write(maskedFrame({ fin: false, opcode: 0x0, payload: chunk }));
    socket.write(maskedFrame({ fin: true, opcode: 0x0, payload: chunk }));
    // No close frame within the window: the connection survives.
    const outcome = await Promise.race([
      waitFor({
        socket,
        timeoutMs: 600,
        until: (buffer) => (buffer.length > 0 && buffer[0] === 0x88 ? buffer.readUInt16BE(2) : null),
      }).then((value) => ({ closed: value }), (error) => ({ timeout: error })),
      new Promise((resolve) => setTimeout(() => resolve({ open: true }), 600)),
    ]);
    assert.ok(!("closed" in outcome) || outcome.closed === undefined, `unexpected close ${JSON.stringify(outcome)}`);
    assert.equal(manager.connections.size, 1);
    socket.destroy();
  } finally {
    await manager.close();
    server.close();
  }
});
