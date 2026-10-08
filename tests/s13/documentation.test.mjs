import assert from "node:assert/strict";
import test from "node:test";
import { createFakeDb } from "./fake-db.mjs";
import {
  createDocumentationPart,
  createDocumentationVersion,
  exportDocumentation,
  getDocumentationVersion,
  importDocumentation,
  resolveDocumentation,
  setStageDocumentationVersion,
  updateDocumentationPart,
} from "../../lib/control/documentation.mjs";
import { importNewApi } from "../../lib/control/openapi-import.mjs";
import { createDeployment } from "../../lib/control/deployments.mjs";
import { exportStage } from "../../lib/control/openapi-export.mjs";

const PROJECT = "44444444-4444-4444-8444-444444444444";
const ADMIN = { type: "user", userId: "u-admin" };

function rig() {
  return createFakeDb({ roles: { "u-admin": "admin" } });
}

async function seedApi(db) {
  const created = await importNewApi(db, ADMIN, {
    projectId: PROJECT,
    body: {
      document: {
        swagger: "2.0",
        info: { title: "Docs API", version: "1" },
        paths: {
          "/pets": {
            get: {
              responses: { 200: { description: "ok" } },
              "x-amazon-apigateway-integration": { type: "mock" },
            },
            post: {
              responses: { 200: { description: "ok" } },
              "x-amazon-apigateway-integration": { type: "mock" },
            },
          },
        },
      },
    },
    options: {},
  });
  return created.body.api.id;
}

test("S13B: documentation inheritance — RESPONSE method \"*\" description applies to GET and POST unless overridden", async () => {
  const db = rig();
  const apiId = await seedApi(db);
  await createDocumentationPart(db, ADMIN, {
    projectId: PROJECT, apiId,
    location: { type: "RESPONSE", path: "/pets", method: "*", statusCode: "200" },
    properties: { description: "Wildcard description" },
  });
  await createDocumentationPart(db, ADMIN, {
    projectId: PROJECT, apiId,
    location: { type: "RESPONSE", path: "/pets", method: "GET", statusCode: "200" },
    properties: { description: "GET description" },
  });
  const parts = (await db.listDocumentationParts({ apiId })).map((row) => ({ location: row.location, properties: row.properties }));

  const forGet = resolveDocumentation(parts, { type: "RESPONSE", path: "/pets", method: "GET", statusCode: "200" });
  assert.equal(forGet.description, "GET description");
  const forPost = resolveDocumentation(parts, { type: "RESPONSE", path: "/pets", method: "POST", statusCode: "200" });
  assert.equal(forPost.description, "Wildcard description");

  // Parent-path inheritance: /pets applies to /pets/{petId} unless overridden.
  await createDocumentationPart(db, ADMIN, {
    projectId: PROJECT, apiId,
    location: { type: "METHOD", path: "/pets", method: "*" },
    properties: { summary: "Pets collection" },
  });
  const child = resolveDocumentation(
    (await db.listDocumentationParts({ apiId })).map((row) => ({ location: row.location, properties: row.properties })),
    { type: "METHOD", path: "/pets/{petId}", method: "GET" },
  );
  assert.equal(child.summary, "Pets collection");
});

test("S13B: documentation version snapshot is immutable after later part edits", async () => {
  const db = rig();
  const apiId = await seedApi(db);
  const created = await createDocumentationPart(db, ADMIN, {
    projectId: PROJECT, apiId,
    location: { type: "RESPONSE", path: "/pets", method: "*", statusCode: "200" },
    properties: { description: "v1 text" },
  });
  await createDocumentationVersion(db, ADMIN, { projectId: PROJECT, apiId, version: "v1", description: "first" });
  await updateDocumentationPart(db, ADMIN, {
    projectId: PROJECT, apiId, partId: created.body.id, properties: { description: "v2 text" },
  });
  const frozen = await getDocumentationVersion(db, ADMIN, { projectId: PROJECT, apiId, version: "v1" });
  assert.equal(frozen.snapshot.length, 1);
  assert.equal(frozen.snapshot[0].properties.description, "v1 text");

  // The stage pins the version; export merges its descriptions.
  await createDeployment(db, ADMIN, { projectId: PROJECT, apiId, description: "d1", stageName: "prod" });
  await setStageDocumentationVersion(db, ADMIN, { projectId: PROJECT, apiId, stageName: "prod", version: "v1" });
  const exported = await exportStage(db, ADMIN, {
    projectId: PROJECT, apiId, stageName: "prod",
    query: { type: "oas30", format: "json", extensions: "none", includeDocs: "true" },
  });
  assert.equal(exported.document.paths["/pets"].get.description, "v1 text");
});

test("S13B: documentation import/export round-trips the AWS documentation extension", async () => {
  const db = rig();
  const apiId = await seedApi(db);
  const result = await importDocumentation(db, ADMIN, {
    projectId: PROJECT, apiId,
    body: {
      document: {
        openapi: "3.0.3",
        info: { title: "x", version: "1" },
        paths: {},
        "x-amazon-apigateway-documentation": {
          version: "v1",
          documentationParts: [
            { location: { type: "METHOD", path: "/pets", method: "GET" }, properties: { summary: "List" } },
            { location: { type: "RESPONSE", path: "/pets", method: "*", statusCode: "200" }, properties: { description: "Ok" } },
          ],
        },
      },
    },
    options: { mode: "overwrite" },
  });
  assert.equal(result.added, 2);
  const exported = await exportDocumentation(db, ADMIN, { projectId: PROJECT, apiId });
  assert.equal(exported["x-amazon-apigateway-documentation"].documentationParts.length, 2);
});
