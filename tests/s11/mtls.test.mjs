/**
 * S11B [runtime]: mTLS over real HTTPS — no cert, untrusted, expired → 403;
 * trusted → 200 with clientCert context; CRL-revoked → 403.
 */

import assert from "node:assert/strict";
import test from "node:test";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { createTlsGatewayServer } from "../../gateway/tls-server.mjs";
import { verifyClientCert } from "../../lib/gateway/core/edge/mtls.mjs";
import { parseTrustStore } from "../../lib/gateway/core/edge/certs.mjs";
import { handle } from "../../lib/gateway/core/index.mjs";
import { compile } from "../../lib/gateway/artifact/compile.mjs";

const CERTS = new URL("./fixtures/certs/", import.meta.url);
async function load(name) {
  return readFile(new URL(name, CERTS), "utf8");
}

process.env.PODS_ALLOW_LOOPBACK = "1";

function mtlsArtifact({ truststorePem, crlPem = null }) {
  const draft = {
    projectId: "proj-1",
    apiId: "api-mtls",
    apiPublicId: "mtls123456",
    protocol: "REST",
    resources: [{ id: "res-root", path: "/" }, { id: "res-items", path: "/items" }],
    methods: [{
      id: "m1", resourceId: "res-items", httpMethod: "GET",
      authorizationType: "NONE", integrationId: "int1",
    }],
    integrations: [{ id: "int1", type: "MOCK", uri: null, timeoutMs: 5000 }],
    edge: {
      mtls: { truststorePem, crlPem },
    },
  };
  const { artifact, errors } = compile(draft);
  assert.equal(errors.length, 0);
  return { ...artifact, allowLoopback: true };
}

function request(port, servername, { cert = null, key = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: "127.0.0.1",
        port,
        path: "/items",
        method: "GET",
        servername,
        rejectUnauthorized: false,
        cert: cert ?? undefined,
        key: key ?? undefined,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.once("error", reject);
    req.end();
  });
}

test("S11B [runtime]: mTLS — no cert, untrusted cert, expired cert → 403; trusted cert → 200 with clientCert context; CRL-revoked → 403", async (t) => {
  const [caPem, serverCert, serverKey, goodCert, goodKey, rogueCert, rogueKey, expiredCert, expiredKey] = await Promise.all([
    load("ca.pem"), load("alpha.pem"), load("alpha.key"),
    load("client-good.pem"), load("client-good.key"),
    load("client-untrusted.pem"), load("client-untrusted.key"),
    load("client-expired.pem"), load("client-expired.key"),
  ]);

  // Unit: truststore parsing warns on expired members.
  const store = parseTrustStore(caPem);
  assert.equal(store.certs.length, 1);
  assert.deepEqual(store.warnings, []);

  // Unit: trusted cert verifies; the clientCert context carries DN/serial.
  const good = verifyClientCert({ leafPem: goodCert }, { certs: store.certs });
  assert.equal(good.ok, true);
  assert.match(good.cert.subjectDN, /CN=good-client/);
  assert.match(good.cert.issuerDN, /CN=Pods Test CA/);
  assert.ok(good.cert.serialNumber.length > 0);
  assert.ok(good.cert.notBefore && good.cert.notAfter);

  // Unit: untrusted and expired fail with reasons.
  assert.equal(verifyClientCert({ leafPem: rogueCert }, { certs: store.certs }).ok, false);
  const expired = verifyClientCert({ leafPem: expiredCert }, { certs: store.certs });
  assert.equal(expired.ok, false);
  assert.match(expired.reason ?? "", /expired|validity/i);

  // Unit: CRL revocation (serial list, Pods extension) fails closed.
  const serial = good.cert.serialNumber;
  const revoked = verifyClientCert({ leafPem: goodCert }, { certs: store.certs }, { crlPem: serial });
  assert.equal(revoked.ok, false);
  assert.match(revoked.reason ?? "", /revok/i);

  // Runtime: the TLS server completes the handshake, then the gateway
  // verifies in code and answers 403/200 per the truststore.
  const artifact = mtlsArtifact({ truststorePem: caPem });
  const gateway = createTlsGatewayServer({
    domains: [{ servername: "mtls.example.com", cert: serverCert, key: serverKey, securityPolicy: "TLS_1_2", mtls: { truststorePem: caPem } }],
    defaultDomain: { cert: serverCert, key: serverKey, securityPolicy: "TLS_1_2" },
    gateway: { artifact },
  });
  const port = await gateway.start(0);
  t.after(() => gateway.close());

  const none = await request(port, "mtls.example.com");
  assert.equal(none.status, 403);

  const rogue = await request(port, "mtls.example.com", { cert: rogueCert, key: rogueKey });
  assert.equal(rogue.status, 403);

  const old = await request(port, "mtls.example.com", { cert: expiredCert, key: expiredKey });
  assert.equal(old.status, 403);

  const trusted = await request(port, "mtls.example.com", { cert: goodCert, key: goodKey });
  assert.equal(trusted.status, 200);
  assert.match(trusted.headers["x-pods-client-cert-subject"] ?? "", /good-client/);

  await gateway.close();

  // CRL-revoked → 403 even with an otherwise trusted cert.
  const crlGateway = createTlsGatewayServer({
    domains: [{ servername: "mtls.example.com", cert: serverCert, key: serverKey, securityPolicy: "TLS_1_2", mtls: { truststorePem: caPem, crlPem: serial } }],
    defaultDomain: { cert: serverCert, key: serverKey, securityPolicy: "TLS_1_2" },
    gateway: { artifact: mtlsArtifact({ truststorePem: caPem, crlPem: serial }) },
  });
  const crlPort = await crlGateway.start(0);
  t.after(() => crlGateway.close());
  const denied = await request(crlPort, "mtls.example.com", { cert: goodCert, key: goodKey });
  assert.equal(denied.status, 403);
  await crlGateway.close();

  // Engine unit: MOCK echoes the verified subject through the context.
  // Headers cannot carry raw newlines, so the test double travels
  // URL-encoded (the header-safe contract in `endpoint-access.mjs`,
  // mirroring how AWS passes the client-cert PEM).
  const ctxArtifact = mtlsArtifact({ truststorePem: caPem });
  const response = await handle(
    new Request("https://mtls.example.com/items", { headers: { host: "mtls.example.com", "x-pods-test-client-cert": encodeURIComponent(goodCert) } }),
    ctxArtifact,
    { allowTestClientCert: true },
  );
  assert.equal(response.status, 200);
});
