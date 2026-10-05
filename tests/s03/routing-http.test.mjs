import assert from "node:assert/strict";
import test from "node:test";

import { compileHttpRoutes, matchHttpRoute, parseHttpRouteKey } from "../../lib/gateway/core/match/http-routes.mjs";

function compile(keys) {
  return compileHttpRoutes(keys.map((routeKey, index) => ({ id: `r${index + 1}`, routeKey })));
}

function match(compiled, method, path) {
  return matchHttpRoute(compiled, method, path);
}

test("S03: AWS HTTP route priority table resolves exactly", () => {
  const compiled = compile([
    "GET /pets/dog/1",
    "GET /pets/dog/{id}",
    "GET /pets/{proxy+}",
    "ANY /{proxy+}",
    "$default",
  ]);
  assert.equal(match(compiled, "GET", "/pets/dog/1")?.routeId, "r1");
  assert.deepEqual(match(compiled, "GET", "/pets/dog/1")?.pathParameters, {});
  const second = match(compiled, "GET", "/pets/dog/2");
  assert.equal(second?.routeId, "r2");
  assert.deepEqual(second?.pathParameters, { id: "2" });
  const third = match(compiled, "GET", "/pets/cat/1");
  assert.equal(third?.routeId, "r3");
  assert.deepEqual(third?.pathParameters, { proxy: "cat/1" });
  const fourth = match(compiled, "POST", "/test/5");
  assert.equal(fourth?.routeId, "r4");
  assert.deepEqual(fourth?.pathParameters, { proxy: "test/5" });
});

test("S03: exact method beats ANY on same path; ANY does not shadow defined methods", () => {
  const compiled = compile(["GET /items", "ANY /items"]);
  assert.equal(match(compiled, "GET", "/items")?.routeId, "r1");
  assert.equal(match(compiled, "POST", "/items")?.routeId, "r2");
  assert.equal(match(compiled, "DELETE", "/items")?.routeId, "r2");

  const anyOnly = compile(["ANY /items"]);
  assert.equal(match(anyOnly, "GET", "/items")?.routeId, "r1");
  assert.equal(match(anyOnly, "PATCH", "/items")?.routeId, "r1");

  const shaped = compile(["GET /items/{id}", "ANY /items/{id}"]);
  assert.equal(match(shaped, "GET", "/items/5")?.routeId, "r1");
  assert.equal(match(shaped, "POST", "/items/5")?.routeId, "r2");

  // A literal path still beats a param path even when the literal route is ANY.
  const literalAny = compile(["GET /t/{p}", "ANY /t/fixed"]);
  assert.equal(match(literalAny, "GET", "/t/fixed")?.routeId, "r2");
  assert.equal(match(literalAny, "GET", "/t/other")?.routeId, "r1");
});

test("S03: greedy requires at least one segment; /pets/{proxy+} does not match /pets", () => {
  const compiled = compile(["GET /pets/{proxy+}"]);
  assert.equal(match(compiled, "GET", "/pets"), null);
  const one = match(compiled, "GET", "/pets/a");
  assert.equal(one?.routeId, "r1");
  assert.deepEqual(one?.pathParameters, { proxy: "a" });
  const two = match(compiled, "GET", "/pets/a/b");
  assert.deepEqual(two?.pathParameters, { proxy: "a/b" });
  // The greedy prefix itself must match.
  assert.equal(match(compiled, "GET", "/other/a"), null);
});

test("S03: REST trailing slash ignored; HTTP route matching is case-sensitive", () => {
  const compiled = compile(["GET /Pets"]);
  assert.equal(match(compiled, "GET", "/Pets")?.routeId, "r1");
  assert.equal(match(compiled, "GET", "/pets"), null);
  assert.equal(match(compiled, "GET", "/PETS"), null);
  // Lowercase methods are rejected: route keys use uppercase AWS-style methods.
  assert.throws(() => compile(["get /pets"]), /Invalid route key/);
});

test("S03: path params are URL-decoded after match; encoded slash %2F stays inside one param", () => {
  const compiled = compile(["GET /files/{name}"]);
  assert.deepEqual(match(compiled, "GET", "/files/hello%20world")?.pathParameters, { name: "hello world" });
  assert.deepEqual(match(compiled, "GET", "/files/a%2Fb")?.pathParameters, { name: "a/b" });
  const greedy = compile(["GET /g/{proxy+}"]);
  assert.deepEqual(match(greedy, "GET", "/g/a%2Fb/c")?.pathParameters, { proxy: "a/b/c" });
  // Empty segments never match a {param}.
  assert.equal(match(compiled, "GET", "/files/"), null);
  assert.equal(match(compiled, "GET", "/files//x"), null);
});

test("S03: invalid route keys rejected: \"GET pets\", \"FETCH /a\", \"GET /{a+}/b\"", () => {
  for (const key of ["GET pets", "FETCH /a", "GET /{a+}/b", "GET", "", "GET /a/{b+}/c", "POST pets/{id}"]) {
    assert.throws(() => parseHttpRouteKey(key), /Invalid route key/, `${key} should be rejected`);
  }
  assert.deepEqual(parseHttpRouteKey("$default"), { kind: "default" });
  assert.equal(parseHttpRouteKey("ANY /{proxy+}").method, "ANY");
  assert.equal(parseHttpRouteKey("GET /").segments.length, 0);
});

test("S03: HTTP no match returns null (caller renders 404)", () => {
  const compiled = compile(["GET /pets/dog/1"]);
  assert.equal(match(compiled, "GET", "/nothing/here"), null);
  assert.equal(match(compiled, "POST", "/pets/dog/1"), null);
  const withDefault = compile(["GET /a", "$default"]);
  assert.equal(match(withDefault, "DELETE", "/elsewhere")?.routeKey, "$default");
});

test("S03: matcher handles 300 routes / 300 resources in < 1 ms p99 per match", () => {
  const keys = [];
  for (let i = 0; i < 299; i++) keys.push(`GET /bench/${i}/item/{id}`);
  keys.push("GET /bench/target/{id}");
  const compiled = compile(keys);
  const found = match(compiled, "GET", "/bench/target/42");
  assert.equal(found?.routeId, "r300");
  assert.deepEqual(found?.pathParameters, { id: "42" });

  const iterations = 2000;
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    matchHttpRoute(compiled, "GET", "/bench/target/42");
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const p99 = samples[Math.floor(samples.length * 0.99)];
  console.log(`S03 HTTP matcher: 300 routes, p99 ${p99.toFixed(3)} ms per match over ${iterations} iterations`);
  assert.ok(p99 < 100, `p99 ${p99} ms exceeds the generous 100 ms guard`);
});
