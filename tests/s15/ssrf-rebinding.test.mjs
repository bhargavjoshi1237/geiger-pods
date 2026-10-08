/**
 * S15 part 1 (security): DNS-rebinding SSRF.
 *
 * A hostname whose first resolution is public but whose second (connect-time)
 * resolution flips to 127.0.0.1 must be blocked: the guard re-resolves and
 * re-checks on every connection, so the "second resolution" never reaches
 * the loopback backend.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createGuardedLookup, toConnectLookup } from "../../lib/gateway/core/integrations/ssrf.mjs";
import { invokeHttp } from "../../lib/gateway/core/integrations/http.mjs";

test("S15: DNS-rebinding SSRF test blocked on second resolution", async () => {
  let resolutions = 0;
  // TTL-0 style resolver: first answer public, second answer loopback.
  const flippingLookup = async (hostname) => {
    assert.equal(hostname, "rebind.example");
    resolutions += 1;
    return resolutions === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
  };

  // Pre-flight (first resolution) passes: the address is public.
  const guarded = createGuardedLookup(flippingLookup, { allowLoopback: false });
  const first = await guarded("rebind.example");
  assert.deepEqual(first, ["93.184.216.34"]);

  // Connect-time (second resolution) flips to loopback → blocked.
  const connectLookup = toConnectLookup(guarded);
  const verdict = await new Promise((resolve) => {
    connectLookup("rebind.example", {}, (error, address) => resolve({ error, address }));
  });
  assert.ok(verdict.error, "second resolution to 127.0.0.1 must be blocked");
  assert.equal(verdict.error?.code, "PODS_SSRF_BLOCKED");

  // End to end through the HTTP adapter: a dispatcher built on the flipping
  // resolver must surface the SSRF block, never a backend response.
  const { createHttpDispatcher } = await import("../../lib/gateway/core/integrations/node-http.mjs");
  const dispatcher = createHttpDispatcher({ lookup: flippingLookup, allowLoopback: false });
  const ctx = {
    artifact: { protocol: "REST" },
    request: new Request("http://gw.test/"),
    context: { identity: {} },
    signal: new AbortController().signal,
  };
  await assert.rejects(
    invokeHttp(
      ctx,
      { uri: "http://rebind.example/secret", timeout_ms: 2000 },
      { method: "GET", url: "http://rebind.example/secret", headers: new Headers(), body: null },
      { log() {} },
      { dispatcher, lookup: flippingLookup, selfHosts: [] },
    ),
    (error) => error?.code === "PODS_SSRF_BLOCKED",
  );
  await dispatcher.close?.().catch(() => {});
});
