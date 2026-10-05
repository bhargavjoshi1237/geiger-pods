import assert from "node:assert/strict";
import test from "node:test";
import { GatewayError } from "../../lib/gateway/core/errors.mjs";
import {
  checkResolvedAddresses,
  classifyHost,
  createGuardedLookup,
  isBlockedIp,
  toConnectLookup,
} from "../../lib/gateway/core/integrations/ssrf.mjs";
import { renderIntegrationUri } from "../../lib/gateway/core/integrations/uri.mjs";
import { invokeHttp } from "../../lib/gateway/core/integrations/http.mjs";
import { buildContext } from "../../lib/gateway/core/context.mjs";

/** Fake resolver: everything resolves per the given table (test seam for DNS). */
function fakeLookup(table) {
  return async (hostname) => {
    if (!(hostname in table)) throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    return table[hostname];
  };
}

test("S04: SSRF guard blocks 127.0.0.1, 10.0.0.1, 169.254.169.254, [::1], and a hostname that resolves to 127.0.0.1", async () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.4.9", "192.168.1.20", "169.254.169.254", "100.64.0.5", "0.0.0.0", "::1", "::", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3"]) {
    assert.equal(isBlockedIp(ip), true, `expected ${ip} to be blocked`);
  }
  for (const ip of ["8.8.8.8", "203.0.113.9", "93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]) {
    assert.equal(isBlockedIp(ip), false, `expected ${ip} to be allowed`);
  }

  // Hostname that resolves to loopback is blocked through the guarded lookup.
  const guarded = createGuardedLookup(fakeLookup({
    "evil.example.com": ["127.0.0.1"],
    "cdn.example.com": ["93.184.216.34"],
    "rebind.example.com": ["93.184.216.34", "10.0.0.9"],
  }));
  await assert.rejects(guarded("127.0.0.1"), (error) => error.code === "PODS_SSRF_BLOCKED");
  await assert.rejects(guarded("[::1]"), (error) => error.code === "PODS_SSRF_BLOCKED");
  await assert.rejects(guarded("evil.example.com"), (error) => error.code === "PODS_SSRF_BLOCKED");
  await assert.rejects(guarded("rebind.example.com"), (error) => error.code === "PODS_SSRF_BLOCKED");
  assert.deepEqual(await guarded("cdn.example.com"), ["93.184.216.34"]);

  // The gateway's own hosts are blocked even when public.
  const selfGuarded = createGuardedLookup(fakeLookup({ "gw.example.com": ["203.0.113.9"] }), {
    selfHosts: ["gw.example.com"],
  });
  await assert.rejects(selfGuarded("gw.example.com"), (error) => error.code === "PODS_SSRF_BLOCKED");

  // The undici connect.lookup adapter surfaces the same verdict per connection.
  const connectLookup = toConnectLookup(createGuardedLookup(fakeLookup({ "evil.example.com": ["127.0.0.1"] })));
  await new Promise((resolve, reject) => {
    connectLookup("evil.example.com", {}, (error) => (error?.code === "PODS_SSRF_BLOCKED" ? resolve() : reject(error ?? new Error("allowed!"))));
  });

  // The adapter refuses before any fetch happens.
  let fetched = false;
  const ctx = buildContext(new Request("https://gw.test/prod/x"), { protocol: "REST", stage: "prod" }, {});
  ctx.signal = new AbortController().signal;
  await assert.rejects(
    invokeHttp(ctx, { type: "HTTP_PROXY", timeout_ms: 2000 }, {
      method: "GET",
      url: "http://169.254.169.254/latest/meta-data/",
      headers: new Headers(),
    }, { log() {} }, {
      lookup: fakeLookup({}),
      requestFn: async () => { fetched = true; throw new Error("must not fetch"); },
    }),
    (error) => error.code === "PODS_SSRF_BLOCKED",
  );
  assert.equal(fetched, false);
  assert.equal(classifyHost("169.254.169.254"), "blocked");
  assert.deepEqual(checkResolvedAddresses("x.test", []), { allowed: false, reason: "unresolvable" });
});

test("S04: URI rendering rejects empty hosts and non-http schemes", () => {
  assert.throws(
    () => renderIntegrationUri("ftp://backend.example.com/x", {}),
    (error) => error instanceof GatewayError && error.type === "API_CONFIGURATION_ERROR",
  );
  assert.throws(
    () => renderIntegrationUri("https://{host}", {}),
    (error) => error instanceof GatewayError && error.type === "API_CONFIGURATION_ERROR",
  );
  assert.throws(
    () => renderIntegrationUri("", {}),
    (error) => error instanceof GatewayError && error.type === "API_CONFIGURATION_ERROR",
  );
  // Stage variables and request.path tokens render and encode.
  const rendered = renderIntegrationUri("https://b.example.com/${stageVariables.ver}/${request.path.id}", {
    stageVariables: { ver: "v1 live" },
    requestPathParams: { id: "a/b" },
  });
  assert.equal(rendered, "https://b.example.com/v1%20live/a%2Fb");
});
