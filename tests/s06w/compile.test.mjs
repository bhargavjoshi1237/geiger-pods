/**
 * S06W compile wiring: S05's compile step must feed real S06 data into
 * `validateProcessing` so configuration errors fail at deploy, and must carry
 * the S06 fields into the artifact for the runtime phases.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { compile } from "../../lib/gateway/artifact/compile.mjs";
import { restDraft, httpDraft } from "./helper.mjs";

const UPSTREAM = "http://127.0.0.1:9/echo";

function errorsOf(draft) {
  return compile(draft).errors;
}

test("S06W: reserved header mapping rejected at compile", async () => {
  const draft = httpDraft(UPSTREAM, {
    integration: {
      requestMapping: { "overwrite:header.Authorization": "$request.header.x-id" },
    },
  });
  const errors = errorsOf(draft);
  assert.ok(
    errors.some((entry) => String(entry.message).includes("reserved")),
    `expected a reserved-header error, got: ${JSON.stringify(errors)}`,
  );
});

test("S06W: template parse error caught at deploy", async () => {
  const draft = restDraft(UPSTREAM, {
    integration: {
      type: "MOCK",
      requestTemplates: { "application/json": "#if($x\nunclosed" },
    },
  });
  const errors = errorsOf(draft);
  assert.ok(
    errors.some((entry) => String(entry.path).includes("requestTemplates")),
    `expected a template error, got: ${JSON.stringify(errors)}`,
  );
});

test("S06W: undeclared method response fails compile", async () => {
  const draft = restDraft(UPSTREAM, {
    integration: {
      type: "MOCK",
      integrationResponses: [
        { statusCode: "200", selectionPattern: "", responseParameters: {}, responseTemplates: {} },
      ],
    },
  });
  const errors = errorsOf(draft);
  assert.ok(
    errors.some((entry) => String(entry.message).includes("no method_responses row")),
    `expected undeclared-method-response error, got: ${JSON.stringify(errors)}`,
  );
});

test("S06W: * + credentials CORS rejected at compile", async () => {
  const draft = httpDraft(UPSTREAM, {
    extra: {
      settings: {
        cors: {
          allowOrigins: ["*"],
          allowMethods: ["GET"],
          allowHeaders: [],
          exposeHeaders: [],
          maxAge: 600,
          allowCredentials: true,
        },
      },
    },
  });
  const errors = errorsOf(draft);
  assert.ok(
    errors.some((entry) => String(entry.path).includes("cors")),
    `expected a CORS error, got: ${JSON.stringify(errors)}`,
  );
});

test("S06W: invalid selection_pattern regex fails compile", async () => {
  const draft = restDraft(UPSTREAM, {
    integration: {
      type: "HTTP",
      uri: `${UPSTREAM}`,
      integrationResponses: [
        { statusCode: "200", selectionPattern: "([", responseParameters: {}, responseTemplates: {} },
      ],
    },
    method: {
      methodResponses: [{ statusCode: "200", responseParameters: {}, responseModels: {} }],
    },
  });
  const errors = errorsOf(draft);
  assert.ok(
    errors.some((entry) => String(entry.message).includes("selection_pattern")),
    `expected a selection-pattern error, got: ${JSON.stringify(errors)}`,
  );
});

test("S06W: clean S06 draft compiles and carries runtime fields", async () => {
  const draft = restDraft(UPSTREAM, {
    integration: {
      type: "MOCK",
      passthroughBehavior: "WHEN_NO_MATCH",
      requestTemplates: { "application/json": '{"statusCode": 200}' },
      integrationResponses: [
        { statusCode: "200", selectionPattern: "", responseParameters: {}, responseTemplates: {} },
      ],
    },
    method: {
      methodResponses: [{ statusCode: "200", responseParameters: {}, responseModels: {} }],
    },
  });
  const { artifact, errors } = compile(draft);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  const method = artifact.resources.find((resource) => resource.id === "res-items").methods.GET;
  assert.deepEqual(method.methodResponses.map((entry) => entry.statusCode), ["200"]);
  const integration = artifact.integrations.int1;
  assert.deepEqual(integration.integrationResponses.map((entry) => entry.statusCode), ["200"]);
  assert.deepEqual(integration.requestTemplates, { "application/json": '{"statusCode": 200}' });
});
