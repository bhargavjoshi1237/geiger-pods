import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer } from "ws";
import {
  acceptAgentSocket,
  createHub,
  isTargetAllowed,
} from "../../lib/gateway/core/integrations/connector.mjs";
import { startAgent } from "../../connector/agent.mjs";
import { startUpstream } from "../fixtures/upstream.mjs";

process.env.PODS_ALLOW_LOOPBACK = "1";

function waitFor(condition, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      let ok = false;
      try {
        ok = condition();
      } catch {
        ok = false;
      }
      if (ok) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("Timed out waiting for condition."));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

test("S04: connector tunnel round-trips a request to a private echo server; disallowed target rejected by agent and gateway; agent loss → DEGRADED/FAILED", async (t) => {
  const privateNet = await startUpstream();
  const allow = [`127.0.0.1:${privateNet.port}`];
  assert.equal(isTargetAllowed(allow, `${privateNet.url}/echo`), true);
  assert.equal(isTargetAllowed(allow, "http://169.254.169.254/"), false);
  assert.equal(isTargetAllowed(["10.0.0.0:8080"], "http://10.1.2.3:8080/x"), false);
  assert.equal(isTargetAllowed(["10.0.0.0/8:8080"], "http://10.1.2.3:8080/x"), true);
  assert.equal(isTargetAllowed(["10.0.0.0/8:8080"], "http://10.1.2.3:9090/x"), false);

  let now = Date.now();
  const hub = createHub({ now: () => now, failedAfterMs: 1000 });
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const accepted = [];
  gateway.on("connection", (ws) => {
    acceptAgentSocket(hub, ws, {
      lookupConnector: async (token) => (
        token === "token-1" ? { connectorId: "ctr-1", allowedTargets: allow } : null
      ),
    }).then((agent) => accepted.push(agent), () => {});
  });
  await new Promise((resolve) => gateway.on("listening", resolve));
  const gatewayUrl = `ws://127.0.0.1:${gateway.address().port}/_connector`;
  t.after(async () => {
    hub.close();
    await new Promise((resolve) => gateway.close(resolve));
    await privateNet.close();
  });

  // Unknown tokens are rejected before attach.
  const { default: Ws } = await import("ws");
  const bad = new Ws(gatewayUrl);
  await new Promise((resolve) => bad.on("open", resolve));
  bad.send(JSON.stringify({ type: "hello", token: "wrong", agentId: "bad" }));
  const badClosed = await new Promise((resolve) => {
    bad.on("close", (code) => resolve(code));
    setTimeout(() => resolve(null), 3000);
  });
  assert.equal(badClosed, 4001);

  const agent = await startAgent({
    url: gatewayUrl,
    token: "token-1",
    allowedTargets: allow,
    reconnectDelayMs: 50,
  });
  t.after(() => agent.close());
  await waitFor(() => hub.agentCount("ctr-1") === 1);
  assert.equal(hub.status("ctr-1").status, "AVAILABLE");

  // Round-trip through the tunnel to the private echo server.
  const result = await hub.invoke("ctr-1", {
    method: "POST",
    url: `${privateNet.url}/echo?via=tunnel`,
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: new TextEncoder().encode(JSON.stringify({ tunneled: true })),
  }, { timeoutMs: 10000 });
  assert.equal(result.status, 200);
  const seen = JSON.parse(Buffer.from(result.body).toString("utf8"));
  assert.equal(seen.method, "POST");
  assert.equal(seen.query, "?via=tunnel");
  assert.equal(JSON.parse(seen.body).tunneled, true);
  assert.equal(seen.headers["x-forwarded-for"], "203.0.113.9");

  // Gateway-side allow-list rejection (no stream opened).
  await assert.rejects(
    hub.invoke("ctr-1", { method: "GET", url: "http://169.254.169.254/latest/", headers: {}, body: null }, { timeoutMs: 3000 }),
    (error) => error.code === "target-not-allowed",
  );

  // Agent-side rejection: the gateway allows, the agent refuses.
  await assert.rejects(
    hub.invoke("ctr-1", { method: "GET", url: "http://169.254.169.254/latest/", headers: {}, body: null }, {
      timeoutMs: 5000,
      connectorTargets: ["169.254.169.254:80"],
    }),
    (error) => /allow-list/.test(error.message),
  );

  // Agent loss: close the agent, statuses degrade then fail.
  await agent.close();
  await waitFor(() => hub.status("ctr-1", now).status === "DEGRADED");
  assert.equal(hub.status("ctr-1", now).agentCount, 0);
  now += 5000;
  assert.equal(hub.status("ctr-1", now).status, "FAILED");
  assert.equal(hub.status("never-seen", now).status, "PENDING");
});

test("S04: connector agent attempts reconnect after gateway loss", async (t) => {
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const hub = createHub();
  gateway.on("connection", (ws) => {
    acceptAgentSocket(hub, ws, {
      lookupConnector: async () => ({ connectorId: "ctr-9", allowedTargets: [] }),
    }).catch(() => {});
  });
  await new Promise((resolve) => gateway.on("listening", resolve));
  t.after(async () => {
    hub.close();
    await new Promise((resolve) => gateway.close(resolve));
  });
  const agent = await startAgent({
    url: `ws://127.0.0.1:${gateway.address().port}/_connector`,
    token: "t",
    reconnectDelayMs: 25,
  });
  t.after(() => agent.close());
  await waitFor(() => hub.agentCount("ctr-9") === 1);
  for (const client of gateway.clients) client.terminate();
  await new Promise((resolve) => gateway.close(resolve));
  await waitFor(() => agent.stats().reconnectAttempts >= 1, 8000);
  assert.equal(agent.state(), "reconnecting");
});
