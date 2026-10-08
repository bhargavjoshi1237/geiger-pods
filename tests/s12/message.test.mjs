import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { wsArtifact, startWsGateway, stubFetch, jsonResponse } from "./helper.mjs";

async function openOk(port, apiPublicId) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/${apiPublicId}/prod`);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    setTimeout(() => reject(new Error("open timeout")), 5000);
  });
  return ws;
}

function onceMessage(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("message timeout")), 5000);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    });
  });
}

test("S12 [runtime]: two-way route returns integration response frame; one-way route returns nothing", async () => {
  const fetch = stubFetch([
    {
      match: "fn-two",
      handler: async () => jsonResponse({ statusCode: 200, body: "two-way-hi" }),
    },
    {
      match: "fn-one",
      handler: async () => jsonResponse({ statusCode: 200, body: "should-be-dropped" }),
    },
  ]);
  const artifact = {
    ...wsArtifact({ apiPublicId: "wstwoway001" }),
    routes: [
      { id: "r-connect", routeKey: "$connect", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: null },
      {
        id: "r-two", routeKey: "two", auth: { type: "NONE" }, apiKeyRequired: false,
        integrationId: "int-two", routeResponseSelectionExpression: "$default",
      },
      {
        id: "r-one", routeKey: "one", auth: { type: "NONE" }, apiKeyRequired: false,
        integrationId: "int-one", routeResponseSelectionExpression: null,
      },
      { id: "r-default", routeKey: "$default", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: null },
    ],
    integrations: {
      "int-two": { type: "FUNCTION_PROXY", function: { provider: "webhook", url: "http://fn.local/fn-two" } },
      "int-one": { type: "FUNCTION_PROXY", function: { provider: "webhook", url: "http://fn.local/fn-one" } },
    },
    settings: { routeSelectionExpression: "$request.body.action" },
  };
  const { gateway, port } = await startWsGateway(artifact, { ports: { fetch } });
  try {
    const ws = await openOk(port, artifact.apiPublicId);
    try {
      ws.send(JSON.stringify({ action: "two" }));
      const two = await onceMessage(ws);
      assert.equal(two, "two-way-hi");
      // One-way: no frame within 400 ms.
      ws.send(JSON.stringify({ action: "one" }));
      const none = await Promise.race([
        onceMessage(ws).then((text) => text),
        new Promise((resolve) => setTimeout(() => resolve(null), 400)),
      ]);
      assert.equal(none, null);
    } finally {
      ws.terminate();
    }
  } finally {
    await gateway.close();
  }
});

test("S12 [runtime]: 129 KB message closed with 1009; fragmented 100 KB message accepted", async () => {
  const fetch = stubFetch([{
    match: "fn-big",
    handler: async () => jsonResponse({ statusCode: 200, body: "big-ok" }),
  }]);
  const artifact = {
    ...wsArtifact({ apiPublicId: "wslimit0001" }),
    routes: [
      { id: "r-connect", routeKey: "$connect", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: null },
      {
        id: "r-big", routeKey: "big", auth: { type: "NONE" }, apiKeyRequired: false,
        integrationId: "int-big", routeResponseSelectionExpression: "$default",
      },
      { id: "r-default", routeKey: "$default", auth: { type: "NONE" }, apiKeyRequired: false, integrationId: null },
    ],
    integrations: { "int-big": { type: "FUNCTION_PROXY", function: { provider: "webhook", url: "http://fn.local/fn-big" } } },
    settings: { routeSelectionExpression: "$request.body.action" },
  };
  const { gateway, port } = await startWsGateway(artifact, { ports: { fetch } });
  try {
    // 129 KB → 1009.
    const oversize = new WebSocket(`ws://127.0.0.1:${port}/${artifact.apiPublicId}/prod`);
    await new Promise((resolve, reject) => {
      oversize.once("open", resolve);
      oversize.once("error", reject);
      setTimeout(() => reject(new Error("open timeout")), 5000);
    });
    const closed = new Promise((resolve, reject) => {
      oversize.once("close", (code) => resolve(code));
      setTimeout(() => reject(new Error("close timeout")), 5000);
    });
    oversize.send(JSON.stringify({ action: "big", data: "x".repeat(129 * 1024) }));
    const code = await closed;
    assert.equal(code, 1009);
    // A single 100 KB frame also exceeds the 32 KB frame quota (S12 §2).
    const single = new WebSocket(`ws://127.0.0.1:${port}/${artifact.apiPublicId}/prod`);
    await new Promise((resolve, reject) => {
      single.once("open", resolve);
      single.once("error", reject);
      setTimeout(() => reject(new Error("open timeout")), 5000);
    });
    try {
      const singleClosed = new Promise((resolve, reject) => {
        single.once("close", (closeCode) => resolve(closeCode));
        setTimeout(() => reject(new Error("close timeout")), 5000);
      });
      single.send(JSON.stringify({ action: "big", data: "z".repeat(100 * 1024) }));
      assert.equal(await singleClosed, 1009);
    } finally {
      single.terminate();
    }
    // Fragmented 100 KB (4 × 25 KB frames) → accepted with a reply.
    const fragmented = new WebSocket(`ws://127.0.0.1:${port}/${artifact.apiPublicId}/prod`);
    await new Promise((resolve, reject) => {
      fragmented.once("open", resolve);
      fragmented.once("error", reject);
      setTimeout(() => reject(new Error("open timeout")), 5000);
    });
    try {
      const reply = new Promise((resolve, reject) => {
        fragmented.once("message", (data) => resolve(String(data)));
        setTimeout(() => reject(new Error("fragment reply timeout")), 5000);
      });
      // True fragmentation: the `ws` client sends continuation frames while
      // `fin: false`. Every frame stays under 32 KB, so the server
      // reassembles up to 128 KB and replies.
      const payload = JSON.stringify({ action: "big", data: "y".repeat(100 * 1024) });
      const part = Math.ceil(payload.length / 4);
      fragmented.send(payload.slice(0, part), { fin: false });
      fragmented.send(payload.slice(part, part * 2), { fin: false });
      fragmented.send(payload.slice(part * 2, part * 3), { fin: false });
      fragmented.send(payload.slice(part * 3));
      const text = await reply;
      assert.equal(text, "big-ok");
    } finally {
      fragmented.terminate();
    }
  } finally {
    await gateway.close();
  }
});
