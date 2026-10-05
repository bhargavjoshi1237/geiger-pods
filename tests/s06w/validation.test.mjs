/**
 * S06W runtime: required query param missing → 400 `BAD_REQUEST_PARAMETERS`;
 * body failing draft-04 schema → 400 `Invalid request body` with AWS-style
 * `validationErrorString`; `$default` model fallback.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { startUpstream } from "../fixtures/upstream.mjs";
import { compileOrThrow, restDraft } from "./helper.mjs";
import { serveArtifact } from "./serve.mjs";

const PET_MODEL = {
  name: "Pet",
  schema: {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string" } },
    additionalProperties: false,
  },
};

test("S06W: required query param missing → 400 BAD_REQUEST_PARAMETERS", async () => {
  const upstream = await startUpstream();
  try {
    const draft = restDraft(upstream.url, {
      apiPublicId: "s06wvalid00001",
      method: {
        requestValidatorId: "params-only",
        requestParameters: { "method.request.querystring.page": true },
      },
      validators: [
        { name: "params-only", validate_request_body: false, validate_request_parameters: true },
      ],
    });
    const artifact = compileOrThrow(draft);
    const { gateway, baseUrl } = await serveArtifact(artifact, { stage: "prod" });
    try {
      const missing = await fetch(`${baseUrl}/items`);
      assert.equal(missing.status, 400);
      assert.equal(missing.headers.get("x-pods-error-type"), "BAD_REQUEST_PARAMETERS");
      assert.deepEqual(await missing.json(), { message: "Missing required request parameters: [page]" });

      const ok = await fetch(`${baseUrl}/items?page=1`);
      assert.equal(ok.status, 200);
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S06W: body failing draft-04 schema → 400 Invalid request body", async () => {
  const upstream = await startUpstream();
  try {
    const draft = restDraft(upstream.url, {
      apiPublicId: "s06wvalid00002",
      method: {
        httpMethod: "POST",
        requestValidatorId: "all",
        requestModels: { "application/json": "Pet" },
      },
      resources: [{ id: "res-root", path: "/" }, { id: "res-items", path: "/pets" }],
      validators: [
        { name: "all", validate_request_body: true, validate_request_parameters: true },
      ],
      models: [PET_MODEL],
    });
    const artifact = compileOrThrow(draft);
    const { gateway, baseUrl } = await serveArtifact(artifact, { stage: "prod" });
    try {
      const bad = await fetch(`${baseUrl}/pets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ age: 3 }),
      });
      assert.equal(bad.status, 400);
      assert.equal(bad.headers.get("x-pods-error-type"), "BAD_REQUEST_BODY");
      assert.deepEqual(await bad.json(), { message: "Invalid request body" });

      const good = await fetch(`${baseUrl}/pets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "fido" }),
      });
      assert.equal(good.status, 200);
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S06W: validationErrorString is AWS-style and visible to gateway templates", async () => {
  const upstream = await startUpstream();
  try {
    const draft = restDraft(upstream.url, {
      apiPublicId: "s06wvalid00003",
      method: {
        httpMethod: "POST",
        requestValidatorId: "all",
        requestModels: { "application/json": "Pet" },
      },
      resources: [{ id: "res-root", path: "/" }, { id: "res-items", path: "/pets" }],
      validators: [
        { name: "all", validate_request_body: true, validate_request_parameters: true },
      ],
      models: [PET_MODEL],
      extra: {
        gatewayResponses: [{
          response_type: "BAD_REQUEST_BODY",
          status_code: null,
          response_parameters: {},
          response_templates: { "application/json": '{"detail":$context.error.messageString,"check":$context.error.validationErrorString}' },
        }],
      },
    });
    const artifact = compileOrThrow(draft);
    const { gateway, baseUrl } = await serveArtifact(artifact, { stage: "prod" });
    try {
      const bad = await fetch(`${baseUrl}/pets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ age: 3 }),
      });
      assert.equal(bad.status, 400);
      const body = await bad.json();
      assert.equal(body.detail, "Invalid request body");
      assert.match(body.check, /missing required properties/);
      assert.match(body.check, /"name"/);
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});

test("S06W: $default model fallback validates vendor JSON content types", async () => {
  const upstream = await startUpstream();
  try {
    const draft = restDraft(upstream.url, {
      apiPublicId: "s06wvalid00004",
      method: {
        httpMethod: "POST",
        requestValidatorId: "all",
        requestModels: { $default: "Pet" },
      },
      resources: [{ id: "res-root", path: "/" }, { id: "res-items", path: "/pets" }],
      validators: [
        { name: "all", validate_request_body: true, validate_request_parameters: true },
      ],
      models: [PET_MODEL],
    });
    const artifact = compileOrThrow(draft);
    const { gateway, baseUrl } = await serveArtifact(artifact, { stage: "prod" });
    try {
      const bad = await fetch(`${baseUrl}/pets`, {
        method: "POST",
        headers: { "content-type": "application/hal+json" },
        body: JSON.stringify({ age: 3 }),
      });
      assert.equal(bad.status, 400);

      const good = await fetch(`${baseUrl}/pets`, {
        method: "POST",
        headers: { "content-type": "application/hal+json" },
        body: JSON.stringify({ name: "fido" }),
      });
      assert.equal(good.status, 200);
    } finally {
      await gateway.close();
    }
  } finally {
    await upstream.close();
  }
});
