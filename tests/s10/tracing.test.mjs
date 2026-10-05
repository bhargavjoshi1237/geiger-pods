import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTraceparent, buildTraceparent, traceparentFromAmzn, resolveInboundTrace,
  decideSampling, defaultSamplingRules, matchGlob, createSpan, endSpan,
  spansToOtlp, exportSpansOtlp,
} from "../../lib/gateway/core/observe/tracing.mjs";

test("S10: inbound X-Amzn-Trace-Id converted; traceparent forwarded to upstream; sampling reservoir 1/s + 5% respected (seeded)", () => {
  const amzn = traceparentFromAmzn("Root=1-67891233-abcdef012345678912345678;Parent=53995c3f42cd8da8;Sampled=1");
  assert.ok(amzn, "expected conversion");
  assert.equal(amzn.traceId, "67891233abcdef012345678912345678");
  assert.equal(amzn.parentId, "53995c3f42cd8da8");
  assert.equal(amzn.sampled, true);
  assert.equal(traceparentFromAmzn("bogus"), null);

  const headers = new Headers({ "x-amzn-trace-id": "Root=1-67891233-abcdef012345678912345678;Parent=53995c3f42cd8da8;Sampled=1" });
  const resolved = resolveInboundTrace(headers);
  assert.equal(resolved.traceId, "67891233abcdef012345678912345678");
  assert.ok(parseTraceparent(resolved.forward), `bad forward traceparent ${resolved.forward}`);
  assert.ok(resolved.forward.startsWith(`00-${resolved.traceId}-`), "forward must keep the trace id");

  const w3c = resolveInboundTrace(new Headers({ traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" }));
  assert.equal(w3c.sampled, true);
  assert.equal(w3c.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(buildTraceparent({ traceId: w3c.traceId, parentId: "00f067aa0ba902b7", sampled: true }), "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");

  // Seeded sampling: reservoir admits the first request each second, then 5%.
  const reservoir = new Map();
  const rules = defaultSamplingRules();
  const request = { host: "x", method: "GET", path: "/pets", apiId: "a", stage: "prod" };
  const first = decideSampling(rules, request, { nowMs: 1000, random: () => 0.99, reservoir });
  assert.equal(first.sampled, true);
  const second = decideSampling(rules, request, { nowMs: 1000, random: () => 0.99, reservoir });
  assert.equal(second.sampled, false);
  const lucky = decideSampling(rules, request, { nowMs: 1000, random: () => 0.01, reservoir });
  assert.equal(lucky.sampled, true);
  const nextSecond = decideSampling(rules, request, { nowMs: 2000, random: () => 0.99, reservoir });
  assert.equal(nextSecond.sampled, true);
  // Path globs route to the matching rule first.
  const routed = decideSampling(
    [{ priority: 1, reservoirPerSec: 0, fixedRate: 1, match: { path: "/admin/**" } }, ...rules],
    { ...request, path: "/admin/users" },
    { nowMs: 5000, random: () => 0.99, reservoir: new Map() },
  );
  assert.equal(routed.sampled, true);
  assert.ok(matchGlob("/admin/**", "/admin/users") && !matchGlob("/admin/**", "/pets"));
});

test("S10: spans carry semantic attributes and export as OTLP/HTTP JSON", async () => {
  const root = createSpan({ traceId: "t", name: "gateway", attributes: { "http.method": "GET" } });
  endSpan(root, root.startMs + 12);
  assert.equal(root.durationMs, 12);
  const payload = spansToOtlp([root], { serviceName: "pods-gateway" });
  assert.equal(payload.resourceSpans[0].scopeSpans[0].spans[0].name, "gateway");
  const bodies = [];
  const result = await exportSpansOtlp([root], {
    endpoint: "https://otel.local",
    headers: { authorization: "Bearer x" },
    fetchImpl: async (url, options) => {
      bodies.push({ url, options });
      return { ok: true, status: 200 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(bodies[0].url, "https://otel.local/v1/traces");
  assert.match(bodies[0].options.body, /pods-gateway/);
  assert.deepEqual(await exportSpansOtlp([], { endpoint: "https://otel.local" }), { ok: true });
});
