/**
 * Stages control-plane service (S05 §2–§3).
 *
 * `pods.stages`: mutable pointers at immutable deployments. Name rules:
 * REST `^[A-Za-z0-9_-]{1,128}$`; HTTP/WS also allow `$default` (one per API,
 * served without a stage path prefix). Variables: ≤100 entries validated by
 * the artifact module (AWS charset).
 *
 * Pointer moves are compare-and-swap (`If-Match` version): they write
 * `stage_history` and publish the `pods:stage-changed` KV message
 * `{apiPublicId, stage}` so every runtime invalidates within 5 s.
 *
 * @module lib/control/stages
 */

import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { resolveApi } from "./apis.mjs";
import { validateStageVariables } from "../gateway/artifact/stage-variables.mjs";

export const STAGE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const STAGE_CHANGED_CHANNEL = "pods:stage-changed";

/**
 * Validates a stage name for the API protocol.
 *
 * @param {string} name
 * @param {string} protocol
 */
export function checkStageName(name, protocol) {
  if (typeof name !== "string" || name.length === 0 || name.length > 128) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.name: must be a string of 1–128 characters");
  }
  if (name === "$default") {
    if (protocol !== "HTTP" && protocol !== "WEBSOCKET") {
      throw new HttpError(422, "invalid_input", 'Invalid request: $.name: "$default" is only available on HTTP and WebSocket APIs.');
    }
    return name;
  }
  if (!STAGE_NAME_PATTERN.test(name)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.name: must match ^[A-Za-z0-9_-]{1,128}$");
  }
  return name;
}

function toView(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    apiId: row.api_id,
    name: row.name,
    deploymentId: row.deployment_id ?? null,
    description: row.description ?? "",
    variables: row.variables ?? {},
    autoDeploy: row.auto_deploy ?? false,
    clientCertificateId: row.client_certificate_id ?? null,
    defaultRouteSettings: row.default_route_settings ?? {},
    routeSettings: row.route_settings ?? {},
    methodSettings: row.method_settings ?? {},
    accessLog: row.access_log ?? null,
    tracingEnabled: row.tracing_enabled ?? false,
    cacheClusterEnabled: row.cache_cluster_enabled ?? false,
    cacheClusterSize: row.cache_cluster_size ?? null,
    canary: row.canary ?? null,
    lastDeploymentStatusMessage: row.last_deployment_status_message ?? null,
    tags: row.tags ?? {},
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function scopedStage(db, api, name) {
  const row = await db.getStageByName({ apiId: api.id, name });
  if (!row) throw new HttpError(404, "not_found", "Stage does not exist.");
  return row;
}

async function publishStageChanged(kv, apiPublicId, stage) {
  if (!kv || typeof kv.publish !== "function") return;
  try {
    await kv.publish(STAGE_CHANGED_CHANNEL, JSON.stringify({ apiPublicId, stage }));
  } catch {
    // Pub/sub is best-effort; the 5 s TTL still propagates.
  }
}

function cleanVariables(input) {
  if (input === undefined) return undefined;
  const { errors, clean } = validateStageVariables(input);
  if (errors.length > 0) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.variables: ${errors[0].message}`);
  }
  return clean;
}

/**
 * Builds the public invoke URL for a stage.
 *
 * Host-based (canonical): `https://{apiPublicId}.{domain}/{stage}/{path}`;
 * `$default` serves without a stage prefix. Path-based (local/dev):
 * `http://localhost:4000/{apiPublicId}/{stage}/{path}`.
 *
 * @param {{ apiPublicId: string, stage: string, domain?: string|null, basePath?: string }} options
 * @returns {string}
 */
export function buildInvokeUrl({ apiPublicId, stage, domain = null, basePath = "" } = {}) {
  const suffix = basePath ? `/${String(basePath).replace(/^\/+/, "")}` : "";
  if (domain) {
    const host = `${apiPublicId}.${domain}`;
    if (stage === "$default") return `https://${host}${suffix || "/"}`;
    return `https://${host}/${stage}${suffix}`;
  }
  if (stage === "$default") return `http://localhost:4000/${apiPublicId}${suffix || "/"}`;
  return `http://localhost:4000/${apiPublicId}/${stage}${suffix}`;
}

/** List stages for an API. Supports `?tag:Key=Value` filters (F26). */
export async function listStages(db, actor, { projectId, apiId, tagFilters = [] }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.apis.view", { projectId });
  const rows = await db.listStages({ apiId: api.id });
  let kept = rows;
  if (tagFilters && tagFilters.length > 0) {
    const { matchesTagFilters, resolveResourceTags } = await import("./tags.mjs");
    kept = [];
    for (const row of rows) {
      const tags = await resolveResourceTags(db, { projectId, resourceType: "stage", resourceId: row.id, rowTags: row.tags });
      if (matchesTagFilters(tags, tagFilters)) kept.push(row);
    }
  }
  return {
    items: kept.map((row) => ({
      ...toView(row),
      invokeUrl: buildInvokeUrl({
        apiPublicId: api.public_id,
        stage: row.name,
        domain: process.env.PODS_GATEWAY_DOMAIN ?? null,
      }),
    })),
    nextCursor: null,
  };
}

/** Get one stage. */
export async function getStage(db, actor, { projectId, apiId, stageName }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.apis.view", { projectId });
  const row = await scopedStage(db, api, stageName);
  return {
    ...toView(row),
    invokeUrl: buildInvokeUrl({
      apiPublicId: api.public_id,
      stage: row.name,
      domain: process.env.PODS_GATEWAY_DOMAIN ?? null,
    }),
  };
}

/** Create a stage (optionally pointing at a deployment). */
export async function createStage(db, actor, { projectId, apiId, input, requestId = null, kv = null }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.stage.write", { projectId, apiId: api.id });
  const name = checkStageName(input?.name, api.protocol);
  if (input?.autoDeploy === true && api.protocol !== "HTTP" && api.protocol !== "WEBSOCKET") {
    throw new HttpError(400, "capability_unsupported", "autoDeploy is only available on HTTP and WebSocket APIs.");
  }
  if (await db.getStageByName({ apiId: api.id, name })) {
    throw new HttpError(409, "conflict", `A stage named "${name}" already exists.`);
  }
  const variables = cleanVariables(input?.variables) ?? {};
  let deploymentId = null;
  if (input?.deploymentId !== undefined && input?.deploymentId !== null) {
    await requirePermission(db, actor, "pods.stage.promote", { projectId, apiId: api.id });
    const deployment = await db.getDeploymentById(input.deploymentId);
    if (!deployment || deployment.api_id !== api.id) {
      throw new HttpError(404, "not_found", "Deployment does not exist.");
    }
    deploymentId = deployment.id;
  }
  const row = await db.insertStage({
    project_id: projectId,
    api_id: api.id,
    name,
    deployment_id: deploymentId,
    description: typeof input?.description === "string" ? input.description : "",
    variables,
    auto_deploy: input?.autoDeploy ?? false,
    client_certificate_id: input?.clientCertificateId ?? null,
    tags: input?.tags ?? {},
    created_by: actor?.userId ?? null,
  });
  if (deploymentId) {
    await db.insertStageHistory({
      project_id: projectId,
      stage_id: row.id,
      from_deployment_id: null,
      to_deployment_id: deploymentId,
      reason: "deploy",
      actor_id: actor?.userId ?? null,
    });
    await publishStageChanged(kv, api.public_id, name);
  }
  await audit(db, actor, {
    action: "stage.create", resourceType: "stage", resourceId: row.id,
    projectId, apiId: api.id, before: null, after: toView(row), requestId,
  });
  return { status: 201, body: toView(row) };
}

/**
 * Move a stage pointer (compare-and-swap). Changing `deploymentId`
 * additionally requires `pods.stage.promote` (also enforced by the DB
 * trigger). Writes `stage_history` and publishes `pods:stage-changed`.
 */
export async function updateStagePointer(db, actor, {
  projectId, apiId, stageName, deploymentId, description, variables,
  expectedVersion = null, requestId = null, kv = null, reason = "deploy",
}) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.stage.write", { projectId, apiId: api.id });
  const current = await scopedStage(db, api, stageName);
  if (expectedVersion !== null && current.version !== expectedVersion) {
    throw new HttpError(409, "version_conflict", `Stage changed (expected version ${expectedVersion}, found ${current.version}).`);
  }
  const patch = {};
  let movesDeployment = false;
  if (deploymentId !== undefined) {
    movesDeployment = String(deploymentId) !== String(current.deployment_id ?? null);
    if (movesDeployment) {
      await requirePermission(db, actor, "pods.stage.promote", { projectId, apiId: api.id });
      const deployment = await db.getDeploymentById(deploymentId);
      if (!deployment || deployment.api_id !== api.id) {
        throw new HttpError(404, "not_found", "Deployment does not exist.");
      }
      patch.deployment_id = deployment.id;
    }
  }
  if (description !== undefined) {
    if (typeof description !== "string" || description.length > 1024) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.description: must be a string of at most 1024 characters");
    }
    patch.description = description;
  }
  if (variables !== undefined) patch.variables = cleanVariables(variables);
  if (Object.keys(patch).length === 0) return toView(current);
  const before = toView(current);
  const next = await db.updateStage({ id: current.id, patch: { ...patch, version: current.version + 1 } });
  if (movesDeployment) {
    await db.insertStageHistory({
      project_id: projectId,
      stage_id: current.id,
      from_deployment_id: current.deployment_id ?? null,
      to_deployment_id: next.deployment_id ?? null,
      reason,
      actor_id: actor?.userId ?? null,
    });
    await publishStageChanged(kv, api.public_id, current.name);
  }
  await audit(db, actor, {
    action: "stage.promote", resourceType: "stage", resourceId: current.id,
    projectId, apiId: api.id, before, after: toView(next), requestId,
  });
  return toView(next);
}

/** Rollback: same as a pointer update with reason `rollback`. */
export async function rollbackStage(db, actor, { projectId, apiId, stageName, deploymentId, expectedVersion = null, requestId = null, kv = null }) {
  return updateStagePointer(db, actor, {
    projectId, apiId, stageName, deploymentId, expectedVersion, requestId, kv, reason: "rollback",
  });
}

/** Delete a stage (manager cannot; needs `pods.stage.delete`). */
export async function deleteStage(db, actor, { projectId, apiId, stageName, requestId = null }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.stage.delete", { projectId, apiId: api.id });
  const current = await scopedStage(db, api, stageName);
  const before = toView(current);
  await db.deleteStage({ id: current.id });
  await audit(db, actor, {
    action: "stage.delete", resourceType: "stage", resourceId: current.id,
    projectId, apiId: api.id, before, after: null, requestId,
  });
  return { id: current.id, deleted: true };
}

/** Stage history (pointer changes with rollback + diff support). */
export async function listStageHistory(db, actor, { projectId, apiId, stageName }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.apis.view", { projectId });
  const stage = await scopedStage(db, api, stageName);
  const rows = await db.listStageHistory({ stageId: stage.id });
  return {
    items: rows.map((row) => ({
      id: row.id,
      stageId: row.stage_id,
      fromDeploymentId: row.from_deployment_id ?? null,
      toDeploymentId: row.to_deployment_id ?? null,
      reason: row.reason,
      actorId: row.actor_id ?? null,
      createdAt: row.created_at,
    })),
    nextCursor: null,
  };
}
