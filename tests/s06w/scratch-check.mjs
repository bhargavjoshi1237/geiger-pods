/**
 * SCRATCH smoke checks for S06W phases (deleted before finishing).
 */
import assert from "node:assert/strict";
import { startUpstream } from "../fixtures/upstream.mjs";
import { compileOrThrow, restDraft, httpDraft } from "./helper.mjs";
import { runHarness } from "./scratch-harness.mjs";

const upstream = await startUpstream();
try {
  // 1. Plain REST proxy passthrough.
  {
    const draft = restDraft(upstream.url, { apiPublicId: "scrt0000000001" });
    const artifact = { ...compileOrThrow(draft), stage: "prod" };
    const res = await runHarness(new Request("http://gw.test/items?page=1"), artifact, "/items");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.query, "?page=1");
    console.log("1. REST proxy passthrough OK");
  }
  // 2. HTTP mapping.
  {
    const draft = httpDraft(upstream.url, {
      apiPublicId: "scrt0000000002",
      integration: { type: "HTTP_PROXY", requestMapping: { "overwrite:header.x-a": "v1" } },
    });
    const artifact = { ...compileOrThrow(draft), stage: "$default" };
    const res = await runHarness(
      new Request("http://gw.test/items", { headers: { "x-a": "old" } }), artifact, "/items",
    );
    assert.equal(res.status, 200);
    const seen = upstream.requests[upstream.requests.length - 1];
    assert.equal(seen.headers["x-a"], "v1");
    console.log("2. HTTP mapping OK");
  }
  // 3. Validation 400.
  {
    const draft = restDraft(upstream.url, {
      apiPublicId: "scrt0000000003",
      method: {
        requestValidatorId: "v",
        requestParameters: { "method.request.querystring.page": true },
      },
      validators: [{ name: "v", validate_request_body: false, validate_request_parameters: true }],
    });
    const artifact = { ...compileOrThrow(draft), stage: "prod" };
    const res = await runHarness(new Request("http://gw.test/items"), artifact, "/items");
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { message: "Missing required request parameters: [page]" });
    console.log("3. validation 400 OK");
  }
  // 4. MOCK + VTL.
  {
    const draft = restDraft(upstream.url, {
      apiPublicId: "scrt0000000004",
      resources: [{ id: "res-root", path: "/" }, { id: "res-items", path: "/items" }],
      method: {
        httpMethod: "POST",
        methodResponses: [{ statusCode: "201", responseParameters: {}, responseModels: {} }],
      },
      integration: {
        type: "MOCK",
        requestTemplates: { "application/json": '{"statusCode": 201, "n": $input.json(\'$.n\')}' },
        integrationResponses: [{
          statusCode: "201", selectionPattern: "", responseParameters: {},
          responseTemplates: { "application/json": '{"made":$input.json(\'$.n\')}' },
        }],
      },
    });
    const artifact = { ...compileOrThrow(draft), stage: "prod" };
    const res = await runHarness(
      new Request("http://gw.test/items", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ n: 7 }),
      }),
      artifact, "/items",
    );
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { made: 7 });
    console.log("4. MOCK+VTL OK");
  }
  // 5. Custom gateway response over harness.
  {
    const draft = restDraft(upstream.url, {
      apiPublicId: "scrt0000000005",
      method: {
        requestValidatorId: "v",
        requestParameters: { "method.request.querystring.page": true },
      },
      validators: [{ name: "v", validate_request_body: false, validate_request_parameters: true }],
      extra: { gatewayResponses: [{ response_type: "DEFAULT_4XX", status_code: "400", response_parameters: {}, response_templates: { "application/json": '{"fb":true}' } }] },
    });
    const artifact = { ...compileOrThrow(draft), stage: "prod" };
    const res = await runHarness(new Request("http://gw.test/items"), artifact, "/items");
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { fb: true });
    console.log("5. custom gateway response OK");
  }
  console.log("ALL SCRATCH CHECKS PASSED");
} finally {
  await upstream.close();
}
