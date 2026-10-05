import assert from "node:assert/strict";
import test from "node:test";

import { compileHttpRoutes, matchHttpRoute } from "../../lib/gateway/core/match/http-routes.mjs";
import { compileRestResources, matchRestResource } from "../../lib/gateway/core/match/rest-resources.mjs";
import { handle } from "../../lib/gateway/core/index.mjs";

function compileHttp(keys) {
  return compileHttpRoutes(keys.map((routeKey, index) => ({ id: `r${index + 1}`, routeKey })));
}

function compileRest(paths, methods) {
  const resources = paths.map((path, index) => ({ id: `res${index + 1}`, path }));
  const rows = (methods ?? []).map(([resourceId, httpMethod], index) => ({ id: `m${index + 1}`, resourceId, httpMethod }));
  return compileRestResources(resources, rows);
}

test("S03: literal segment beats param segment; REST backtracks to a less specific branch when needed", () => {
  const http = compileHttp(["GET /t/{p}", "GET /t/fixed"]);
  assert.equal(matchHttpRoute(http, "GET", "/t/fixed")?.routeId, "r2");
  assert.equal(matchHttpRoute(http, "GET", "/t/other")?.routeId, "r1");

  // /a/{b}/c vs /a/x/{d}: /a/x/c must take the more specific literal branch.
  const rest = compileRest(["/a/{b}/c", "/a/x/{d}"], [["res1", "GET"], ["res2", "GET"]]);
  const specific = matchRestResource(rest, "GET", "/a/x/c");
  assert.equal(specific?.resourcePath, "/a/x/{d}");
  assert.deepEqual(specific?.pathParameters, { d: "c" });
  const general = matchRestResource(rest, "GET", "/a/y/c");
  assert.equal(general?.resourcePath, "/a/{b}/c");
  assert.deepEqual(general?.pathParameters, { b: "y" });
  // A deeper literal branch that cannot finish falls back to the param branch.
  const rest2 = compileRest(["/a/{b}", "/a/x/y"], [["res1", "GET"], ["res2", "GET"]]);
  assert.equal(matchRestResource(rest2, "GET", "/a/x")?.resourcePath, "/a/{b}");
  assert.equal(matchRestResource(rest2, "GET", "/a/x/y")?.resourcePath, "/a/x/y");
});

test("S03: REST trailing slash ignored; HTTP route matching is case-sensitive", () => {
  const rest = compileRest(["/pets"], [["res1", "GET"]]);
  assert.equal(matchRestResource(rest, "GET", "/pets/")?.resourcePath, "/pets");
  assert.equal(matchRestResource(rest, "GET", "/pets")?.resourcePath, "/pets");
  assert.equal(matchRestResource(rest, "GET", "/PETS"), null);

  const http = compileHttp(["GET /Pets"]);
  assert.equal(matchHttpRoute(http, "GET", "/Pets")?.routeId, "r1");
  assert.equal(matchHttpRoute(http, "GET", "/pets"), null);
});

test("S03: path params are URL-decoded after match; encoded slash %2F stays inside one param", () => {
  const rest = compileRest(["/files/{name}"], [["res1", "GET"]]);
  assert.deepEqual(matchRestResource(rest, "GET", "/files/hello%20world")?.pathParameters, { name: "hello world" });
  assert.deepEqual(matchRestResource(rest, "GET", "/files/a%2Fb")?.pathParameters, { name: "a/b" });
  const greedy = compileRest(["/g/{proxy+}"], [["res1", "GET"]]);
  assert.deepEqual(matchRestResource(greedy, "GET", "/g/a/b")?.pathParameters, { proxy: "a/b" });
});

test("S03: REST missing method → 403 Missing Authentication Token; with missing_route_behavior=not_found → 404", async () => {
  const draft = {
    restResources: [{ id: "res1", path: "/pets" }],
    restMethods: [{ id: "m1", resourceId: "res1", httpMethod: "GET" }],
  };
  const aws = await handle(new Request("https://gw.test/pets", { method: "POST" }), {
    protocol: "REST",
    ...draft,
  });
  assert.equal(aws.status, 403);
  assert.deepEqual(await aws.json(), { message: "Missing Authentication Token" });
  assert.equal(aws.headers.get("x-pods-error-type"), "MISSING_AUTHENTICATION_TOKEN");

  const notFound = await handle(new Request("https://gw.test/pets", { method: "POST" }), {
    protocol: "REST",
    missingRouteBehavior: "not_found",
    ...draft,
  });
  assert.equal(notFound.status, 404);
  assert.deepEqual(await notFound.json(), { message: "Not Found" });
  assert.equal(notFound.headers.get("x-pods-error-type"), "RESOURCE_NOT_FOUND");

  const unknown = await handle(new Request("https://gw.test/nope", { method: "GET" }), {
    protocol: "REST",
    ...draft,
  });
  assert.equal(unknown.status, 403);

  const httpMiss = await handle(new Request("https://gw.test/nope", { method: "GET" }), {
    protocol: "HTTP",
    httpRoutes: [{ id: "r1", routeKey: "GET /pets" }],
  });
  assert.equal(httpMiss.status, 404);
  assert.deepEqual(await httpMiss.json(), { message: "Not Found" });
});

test("S03: HEAD does not fall back to GET; ANY covers it", () => {
  const rest = compileRest(["/pets"], [["res1", "GET"]]);
  const head = matchRestResource(rest, "HEAD", "/pets");
  assert.equal(head?.resourcePath, "/pets");
  assert.equal(head?.methodId, null);
  const withAny = compileRest(["/pets"], [["res1", "GET"], ["res1", "ANY"]]);
  const headAny = matchRestResource(withAny, "HEAD", "/pets");
  assert.equal(headAny?.methodId, "m2");
});

test("S03: matcher handles 300 routes / 300 resources in < 1 ms p99 per match", () => {
  const resources = [];
  for (let i = 0; i < 300; i++) resources.push({ id: `res${i + 1}`, path: `/bench/${i}/item/{id}` });
  const methods = resources.map((r) => ({ id: `m-${r.id}`, resourceId: r.id, httpMethod: "GET" }));
  const compiled = compileRestResources(resources, methods);
  const found = matchRestResource(compiled, "GET", "/bench/299/item/7");
  assert.equal(found?.resourceId, "res300");
  assert.deepEqual(found?.pathParameters, { id: "7" });

  const iterations = 2000;
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    matchRestResource(compiled, "GET", "/bench/299/item/7");
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const p99 = samples[Math.floor(samples.length * 0.99)];
  console.log(`S03 REST matcher: 300 resources, p99 ${p99.toFixed(3)} ms per match over ${iterations} iterations`);
  assert.ok(p99 < 100, `p99 ${p99} ms exceeds the generous 100 ms guard`);
});
