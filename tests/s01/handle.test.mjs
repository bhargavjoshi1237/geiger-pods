import assert from "node:assert/strict";
import test from "node:test";

import { handle } from "../../lib/gateway/core/index.mjs";

function get(path, protocol) {
  return new Request(`https://gw.example${path}`, {
    headers: { host: "demo.execute.gw.example" },
  });
}

test("S01: unknown route on stub artifact → REST 403 Missing Authentication Token, HTTP 404 Not Found", async () => {
  const rest = await handle(get("/nope"), { protocol: "REST", apiId: "a1b2c3d4e5" }, {});
  assert.equal(rest.status, 403);
  assert.equal(rest.headers.get("x-pods-error-type"), "MISSING_AUTHENTICATION_TOKEN");
  assert.deepEqual(await rest.json(), { message: "Missing Authentication Token" });

  const http = await handle(get("/nope"), { protocol: "HTTP", apiId: "a1b2c3d4e5" }, {});
  assert.equal(http.status, 404);
  assert.equal(http.headers.get("x-pods-error-type"), "RESOURCE_NOT_FOUND");
  assert.deepEqual(await http.json(), { message: "Not Found" });
});

test("S01: handle responses carry x-pods-request-id", async () => {
  for (const protocol of ["REST", "HTTP"]) {
    const res = await handle(get("/nope"), { protocol }, {});
    const id = res.headers.get("x-pods-request-id");
    assert.ok(id && id.length > 0, `expected a request id for ${protocol}`);
  }
});
