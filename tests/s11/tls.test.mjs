/**
 * S11A [runtime]: SNI serves the right cert per domain; TLS policy version
 * gating (real HTTPS server, fixture certs).
 */

import assert from "node:assert/strict";
import test from "node:test";
import tls from "node:tls";
import { readFile } from "node:fs/promises";
import { createTlsGatewayServer } from "../../gateway/tls-server.mjs";
import { isTlsVersionAllowed, TLS_POLICIES } from "../../lib/gateway/core/edge/tls-policy.mjs";

const CERTS = new URL("./fixtures/certs/", import.meta.url);
async function load(name) {
  return readFile(new URL(name, CERTS), "utf8");
}

function peerCn(port, servername, { minVersion = undefined, maxVersion = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: "127.0.0.1", port, servername, rejectUnauthorized: false, minVersion, maxVersion },
      () => {
        const cert = socket.getPeerCertificate();
        const cn = cert?.subject?.CN ?? null;
        socket.end();
        resolve(cn);
      },
    );
    socket.once("error", reject);
  });
}

test("S11A [runtime]: SNI serves the right cert per domain; TLS 1.1 rejected under TLS_1_2; TLS 1.2 rejected under TLS13_ONLY", async (t) => {
  // Policy unit checks (no sockets).
  assert.equal(isTlsVersionAllowed("TLS_1_2", "TLSv1.1"), false);
  assert.equal(isTlsVersionAllowed("TLS_1_2", "TLSv1.2"), true);
  assert.equal(isTlsVersionAllowed("TLS_1_2", "TLSv1.3"), true);
  assert.equal(isTlsVersionAllowed("TLS13_ONLY", "TLSv1.2"), false);
  assert.equal(isTlsVersionAllowed("TLS13_ONLY", "TLSv1.3"), true);
  assert.ok(TLS_POLICIES.TLS_1_2 && TLS_POLICIES.TLS13_ONLY && TLS_POLICIES.TLS13_1_2_STRICT);

  const [alphaCert, alphaKey, betaCert, betaKey] = await Promise.all([
    load("alpha.pem"), load("alpha.key"), load("beta.pem"), load("beta.key"),
  ]);
  const gateway = createTlsGatewayServer({
    domains: [
      { servername: "alpha.example.com", cert: alphaCert, key: alphaKey, securityPolicy: "TLS_1_2" },
      { servername: "beta.example.com", cert: betaCert, key: betaKey, securityPolicy: "TLS_1_2" },
    ],
    defaultDomain: { cert: alphaCert, key: alphaKey, securityPolicy: "TLS_1_2" },
    handler: async (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, sni: req.socket.servername ?? null }));
    },
  });
  const port = await gateway.start(0);
  t.after(() => gateway.close());

  // SNI serves the right cert per domain.
  assert.equal(await peerCn(port, "alpha.example.com"), "alpha.example.com");
  assert.equal(await peerCn(port, "beta.example.com"), "beta.example.com");

  // TLS 1.1 is rejected under TLS_1_2 (handshake failure, not HTTP).
  await assert.rejects(peerCn(port, "alpha.example.com", { maxVersion: "TLSv1.1" }));
  // TLS 1.2 succeeds under TLS_1_2.
  assert.equal(await peerCn(port, "alpha.example.com", { minVersion: "TLSv1.2", maxVersion: "TLSv1.2" }), "alpha.example.com");

  await gateway.close();

  // Under TLS13_ONLY, TLS 1.2 is rejected (when the runtime supports TLS 1.3).
  const strict = createTlsGatewayServer({
    domains: [],
    defaultDomain: { cert: alphaCert, key: alphaKey, securityPolicy: "TLS13_ONLY" },
    handler: async (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  });
  const strictPort = await strict.start(0);
  t.after(() => strict.close());
  await assert.rejects(peerCn(strictPort, "alpha.example.com", { minVersion: "TLSv1.2", maxVersion: "TLSv1.2" }));
});
