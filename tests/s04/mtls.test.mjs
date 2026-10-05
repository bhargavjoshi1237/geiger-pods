import assert from "node:assert/strict";
import test from "node:test";
import https from "node:https";
import { X509Certificate } from "node:crypto";
import { buildContext } from "../../lib/gateway/core/context.mjs";
import { invokeHttp } from "../../lib/gateway/core/integrations/http.mjs";
import { issueSelfSignedCertificate } from "../../lib/control/cert-issue.mjs";

process.env.PODS_ALLOW_LOOPBACK = "1";

test("S04: client certificate is presented to an mTLS backend", async (t) => {
  const serverCreds = issueSelfSignedCertificate({ commonName: "mtls-backend" });
  const clientCreds = issueSelfSignedCertificate({ commonName: "pods-backend-client" });
  // Sanity: our issuer really makes parseable, self-consistent certs.
  const parsed = new X509Certificate(clientCreds.certificatePem);
  assert.match(parsed.subject, /CN=pods-backend-client/);
  assert.ok(parsed.validTo);

  let peerPem = null;
  const server = https.createServer(
    {
      cert: serverCreds.certificatePem,
      key: serverCreds.privateKeyPem,
      requestCert: true,
      rejectUnauthorized: false,
    },
    (req, res) => {
      peerPem = req.socket.getPeerCertificate?.()?.raw?.toString?.("base64") ?? null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const ctx = buildContext(new Request("https://gw.test/prod/x"), { protocol: "REST", stage: "prod" }, {});
  ctx.signal = new AbortController().signal;
  const result = await invokeHttp(ctx, {
    type: "HTTP_PROXY",
    timeout_ms: 8000,
    tls: { insecureSkipVerification: true },
  }, {
    method: "GET",
    url: `https://127.0.0.1:${port}/secure`,
    headers: new Headers(),
  }, { log() {} }, {
    clientCert: { certPem: clientCreds.certificatePem, keyPem: clientCreds.privateKeyPem },
  });
  assert.equal(result.status, 200);
  assert.ok(peerPem, "expected the backend to see a client certificate");
  const presented = new X509Certificate(Buffer.from(peerPem, "base64"));
  assert.match(presented.subject, /CN=pods-backend-client/);
});
