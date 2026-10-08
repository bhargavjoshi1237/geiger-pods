// OpenAPI export service (S13 part A, §A).
//
// `GET …/apis/{apiId}/stages/{stage}/export` is generated from the
// stage's **deployed artifact**, never the draft (AWS exports a stage).
// Draft export (`GET …/apis/{apiId}/export?source=draft`) is the Pods
// extension for pre-deploy review. `extensions=aws` emits
// `x-amazon-apigateway-*` so the API can move back to AWS; `postman`
// emits a Postman Collection v2.1.
//
// Later passes (SDKs, portals) build on `loadExportContext`; keep stable.
//
// @module lib/control/openapi-export

import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { resolveApi } from "./apis.mjs";
import { compileDraft } from "./deployments.mjs";
import { buildExportDocument, buildPostmanCollection, serializeExport } from "../gateway/distribution/openapi.mjs";
import { buildInvokeUrl } from "./stages.mjs";

const TYPES = ["oas30", "swagger"];
const FORMATS = ["json", "yaml"];
const EXTENSIONS = ["none", "pods", "aws", "postman"];

function checkEnum(value, allowed, name, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (!allowed.includes(value)) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.${name}: must be one of ${allowed.join(", ")}`);
  }
  return value;
}

/**
 * Loads the artifact + stage context an export is built from. Exported
 * for the SDK pass, which renders clients from the same snapshot.
 *
 * @returns {Promise<{ api: object, stage: object|null, artifact: object,
 *   docsByLocation: Map<string, object>, invokeUrl: string|null }> }
 */
export async function loadExportContext(db, { projectId, apiId, stageName = null, fromDraft = false, domain = null }) {
  const api = await resolveApi(db, projectId, apiId);
  if (api.protocol !== "REST" && api.protocol !== "HTTP") {
    throw new HttpError(400, "capability_unsupported", "OpenAPI export is only available on REST and HTTP APIs.");
  }
  let stage = null;
  let artifact = null;
  if (fromDraft) {
    ({ artifact } = await compileDraft(db, api));
  } else {
    if (!stageName) throw new HttpError(422, "invalid_input", "A stage name is required to export a deployed stage.");
    stage = await db.getStageByName({ apiId: api.id, name: stageName }).catch(() => null);
    if (!stage) throw new HttpError(404, "not_found", "Stage does not exist.");
    if (!stage.deployment_id) throw new HttpError(409, "not_deployed", "Stage has no deployment to export.");
    const deployment = await db.getDeploymentById(stage.deployment_id);
    if (!deployment) throw new HttpError(404, "not_found", "Deployment does not exist.");
    artifact = deployment.artifact;
  }
  const docsByLocation = new Map();
  const docsVersion = stage?.documentation_version ?? null;
  if (docsVersion && typeof db.getDocumentationVersion === "function") {
    const record = await db.getDocumentationVersion({ apiId: api.id, version: docsVersion }).catch(() => null);
    const snapshot = record?.snapshot ?? [];
    for (const part of snapshot) {
      const location = part?.location ?? {};
      const key = `${location.method ?? "*"} ${location.path ?? "/"}`;
      docsByLocation.set(key, { ...(docsByLocation.get(key) ?? {}), ...(part?.properties ?? {}) });
    }
  }
  const invokeUrl = fromDraft
    ? null
    : buildInvokeUrl({
        apiPublicId: api.public_id,
        stage: stage.name,
        domain: domain ?? process.env.PODS_GATEWAY_DOMAIN ?? null,
      });
  return { api, stage, artifact, docsByLocation, invokeUrl };
}

/**
 * Exports a deployed stage.
 *
 * `type=oas30|swagger`, `format=json|yaml`,
 * `extensions=none|pods|aws|postman`, `includeDocs=true`,
 * `domain=` overrides the `servers`/`host` base.
 */
export async function exportStage(db, actor, { projectId, apiId, stageName, query = {}, requestId = null }) {
  await requirePermission(db, actor, "pods.api.export", { projectId });
  const type = checkEnum(query.type, TYPES, "type", "oas30");
  const format = checkEnum(query.format, FORMATS, "format", "json");
  const extensions = checkEnum(query.extensions, EXTENSIONS, "extensions", "aws");
  const includeDocs = query.includeDocs === true || query.includeDocs === "true";
  const domain = typeof query.domain === "string" && query.domain !== "" ? query.domain.slice(0, 253) : null;

  const { api, stage, artifact, docsByLocation, invokeUrl } = await loadExportContext(db, {
    projectId, apiId, stageName, domain,
  });

  if (extensions === "postman") {
    const baseUrl = (invokeUrl ?? `https://localhost/${stage.name}`).replace(/\/+$/, "");
    const seed = buildExportDocument({
      artifact, stageName: stage.name, invokeUrl, type: "oas30",
      extensions: "none", includeDocs, docsByLocation,
    });
    const collection = buildPostmanCollection({ doc: seed, name: api.name, baseUrl });
    await audit(db, actor, {
      action: "api.export", resourceType: "api", resourceId: api.id,
      projectId, apiId: api.id,
      after: { stage: stage.name, extensions: "postman", operations: collection.item.length }, requestId,
    });
    return { format: "json", contentType: "application/json", extensions: "postman", document: collection };
  }

  const doc = buildExportDocument({
    artifact, stageName: stage.name, invokeUrl, type, extensions, includeDocs, docsByLocation,
  });
  await audit(db, actor, {
    action: "api.export", resourceType: "api", resourceId: api.id,
    projectId, apiId: api.id,
    after: { stage: stage.name, type, format, extensions, includeDocs }, requestId,
  });
  return {
    format,
    contentType: format === "yaml" ? "application/yaml" : "application/json",
    extensions,
    document: format === "yaml" ? serializeExport(doc, "yaml") : doc,
  };
}

/** Draft export (Pods extension): compiles the draft without deploying. */
export async function exportDraft(db, actor, { projectId, apiId, query = {}, requestId = null }) {
  await requirePermission(db, actor, "pods.api.export", { projectId });
  const type = checkEnum(query.type, TYPES, "type", "oas30");
  const format = checkEnum(query.format, FORMATS, "format", "json");
  const extensions = checkEnum(query.extensions, [...EXTENSIONS.filter((entry) => entry !== "postman")], "extensions", "aws");
  const includeDocs = query.includeDocs === true || query.includeDocs === "true";

  const { api, artifact } = await loadExportContext(db, { projectId, apiId, fromDraft: true });
  const doc = buildExportDocument({
    artifact, stageName: "draft", invokeUrl: null, type, extensions, includeDocs,
    docsByLocation: new Map(),
  });
  await audit(db, actor, {
    action: "api.export", resourceType: "api", resourceId: api.id,
    projectId, apiId: api.id, after: { source: "draft", type, format, extensions }, requestId,
  });
  return {
    format,
    contentType: format === "yaml" ? "application/yaml" : "application/json",
    extensions,
    document: format === "yaml" ? serializeExport(doc, "yaml") : doc,
  };
}
