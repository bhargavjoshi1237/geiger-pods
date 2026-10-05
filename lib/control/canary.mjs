/**
 * Canary release control-plane service (S09 §1).
 *
 * `stages.canary` jsonb: `{ deploymentId, percentTraffic, stageVariableOverrides,
 * useStageCache, sticky? }`. Operations:
 * - Create/update canary: `pods.stage.write` (starts at the stage's current deployment).
 * - Deploy to canary: creates a deployment and points only the canary at it.
 * - Promote: `pods.stage.promote`; stage `deploymentId` ← canary's, optionally
 *   merge overrides, reset to 0% or remove, `stage_history` reason `canary_promote`.
 * - Delete canary: all traffic returns to base.
 *
 * @module lib/control/canary
 */

import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { resolveApi } from "./apis.mjs";
import { compileDraft } from "./deployments.mjs";
import { newPublicId } from "../gateway/ids.mjs";
import { randomUUID } from "node:crypto";
import { validateCanaryConfig } from "../gateway/core/release/canary.mjs";
import { validateStageVariables } from "../gateway/artifact/stage-variables.mjs";

function toCanaryView(raw) {
  if (!raw) return null;
  return {
    deploymentId: raw.deploymentId ?? raw.deployment_id ?? null,
    percentTraffic: Number(raw.percentTraffic ?? raw.percent_traffic ?? 0),
    stageVariableOverrides: { ...(raw.stageVariableOverrides ?? raw.stage_variable_overrides ?? {}) },
    useStageCache: Boolean(raw.useStageCache ?? raw.use_stage_cache ?? false),
    sticky: raw.sticky ?? null,
  };
}

function toSnake(view) {
  return {
    deploymentId: view.deploymentId,
    percentTraffic: view.percentTraffic,
    stageVariableOverrides: view.stageVariableOverrides,
    useStageCache: view.useStageCache,
    ...(view.sticky ? { sticky: view.sticky } : {}),
  };
}

async function scopedStage(db, api, stageName) {
  const row = await db.getStageByName({ apiId: api.id, name: stageName });
  if (!row) throw new HttpError(404, "not_found", "Stage does not exist.");
  return row;
}

/** Get the canary config for a stage. */
export async function getCanary(db, actor, { projectId, apiId, stageName }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.apis.view", { projectId });
  if (api.protocol !== "REST") {
    throw new HttpError(400, "capability_unsupported", "Canary releases are only supported on REST APIs.");
  }
  const stage = await scopedStage(db, api, stageName);
  return toCanaryView(stage.canary ?? null);
}

/**
 * Create or update the canary on a stage. Its `deploymentId` starts as the
 * stage's current deployment when not given.
 */
export async function putCanary(db, actor, { projectId, apiId, stageName, input, requestId = null }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.stage.write", { projectId, apiId: api.id });
  if (api.protocol !== "REST") {
    throw new HttpError(400, "capability_unsupported", "Canary releases are only supported on REST APIs.");
  }
  const stage = await scopedStage(db, api, stageName);
  const clean = validateCanaryConfig(input ?? {});
  let deploymentId = clean.deploymentId;
  if (!deploymentId) {
    deploymentId = stage.deployment_id ?? null;
    if (!deploymentId) {
      throw new HttpError(422, "invalid_input", "The stage has no deployment; point the stage at a deployment first or pass deploymentId.");
    }
  } else {
    const deployment = await db.getDeploymentById(deploymentId);
    if (!deployment || deployment.api_id !== api.id) {
      throw new HttpError(404, "not_found", "Deployment does not exist.");
    }
  }
  if (clean.stageVariableOverrides && Object.keys(clean.stageVariableOverrides).length > 0) {
    const { errors } = validateStageVariables(clean.stageVariableOverrides);
    if (errors.length > 0) {
      throw new HttpError(422, "invalid_input", `Invalid request: $.stageVariableOverrides: ${errors[0].message}`);
    }
  }
  const view = { ...clean, deploymentId };
  const before = toCanaryView(stage.canary ?? null);
  const next = await db.updateStage({ id: stage.id, patch: { canary: toSnake(view), version: stage.version + 1 } });
  await audit(db, actor, {
    action: "stage.canary_update", resourceType: "stage", resourceId: stage.id,
    projectId, apiId: api.id, before, after: toCanaryView(next.canary ?? null), requestId,
  });
  return toCanaryView(next.canary ?? null);
}

/** Delete the canary: all traffic returns to the base deployment. */
export async function deleteCanary(db, actor, { projectId, apiId, stageName, requestId = null }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.stage.write", { projectId, apiId: api.id });
  const stage = await scopedStage(db, api, stageName);
  const before = toCanaryView(stage.canary ?? null);
  const next = await db.updateStage({ id: stage.id, patch: { canary: null, version: stage.version + 1 } });
  void next;
  await audit(db, actor, {
    action: "stage.canary_delete", resourceType: "stage", resourceId: stage.id,
    projectId, apiId: api.id, before, after: null, requestId,
  });
  return { deleted: true };
}

/**
 * Deploy to canary: creates a deployment from the current draft and points
 * only the canary at it (AWS `CreateDeployment` with `canarySettings`).
 */
export async function deployToCanary(db, actor, {
  projectId, apiId, stageName, description = "", percentTraffic = 10,
  stageVariableOverrides = {}, useStageCache = false, requestId = null, kv = null,
}) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.deployment.create", { projectId, apiId: api.id });
  await requirePermission(db, actor, "pods.stage.write", { projectId, apiId: api.id });
  if (api.protocol !== "REST") {
    throw new HttpError(400, "capability_unsupported", "Canary releases are only supported on REST APIs.");
  }
  const stage = await scopedStage(db, api, stageName);
  const clean = validateCanaryConfig({ percentTraffic, stageVariableOverrides, useStageCache });
  const { artifact, warnings } = await compileDraft(db, api);
  const row = await db.insertDeployment({
    id: randomUUID(),
    project_id: projectId,
    api_id: api.id,
    public_id: newPublicId().slice(0, 6),
    description,
    artifact,
    digest: artifact.digest,
    schema_version: 1,
    warnings,
    created_by: actor?.userId ?? null,
  });
  const view = { ...clean, deploymentId: row.id };
  await db.updateStage({ id: stage.id, patch: { canary: toSnake(view), version: stage.version + 1 } });
  void kv;
  await audit(db, actor, {
    action: "deployment.canary_deploy", resourceType: "deployment", resourceId: row.id,
    projectId, apiId: api.id, before: null, after: { deploymentId: row.id, stage: stageName, canary: toCanaryView(toSnake(view)) }, requestId,
  });
  return { status: 201, body: { deploymentId: row.id, digest: row.digest, canary: toCanaryView(toSnake(view)) } };
}

/**
 * Promote: stage `deploymentId` ← canary's; optionally merge overrides into
 * the stage variables; reset to 0% on the new deployment or remove.
 * Recorded in `stage_history` (reason `canary_promote`).
 */
export async function promoteCanary(db, actor, {
  projectId, apiId, stageName, mergeVariables = false, removeCanary = false, requestId = null, kv = null,
}) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.stage.promote", { projectId, apiId: api.id });
  const stage = await scopedStage(db, api, stageName);
  const canary = toCanaryView(stage.canary ?? null);
  if (!canary?.deploymentId) {
    throw new HttpError(409, "no_canary", "This stage has no canary to promote.");
  }
  const deployment = await db.getDeploymentById(canary.deploymentId);
  if (!deployment || deployment.api_id !== api.id) {
    throw new HttpError(404, "not_found", "The canary deployment does not exist.");
  }
  const from = stage.deployment_id ?? null;
  const patch = { deployment_id: deployment.id, version: stage.version + 1 };
  if (mergeVariables && canary.stageVariableOverrides && Object.keys(canary.stageVariableOverrides).length > 0) {
    const merged = { ...(stage.variables ?? {}), ...canary.stageVariableOverrides };
    const { errors, clean } = validateStageVariables(merged);
    if (errors.length > 0) {
      throw new HttpError(422, "invalid_input", `Invalid merged variables: ${errors[0].message}`);
    }
    patch.variables = clean;
  }
  if (removeCanary) {
    patch.canary = null;
  } else {
    patch.canary = toSnake({ ...canary, percentTraffic: 0 });
  }
  const next = await db.updateStage({ id: stage.id, patch });
  await db.insertStageHistory({
    project_id: projectId,
    stage_id: stage.id,
    from_deployment_id: from,
    to_deployment_id: deployment.id,
    reason: "canary_promote",
    actor_id: actor?.userId ?? null,
  });
  if (kv && typeof kv.publish === "function") {
    try {
      await kv.publish("pods:stage-changed", JSON.stringify({ apiPublicId: api.public_id, stage: stageName }));
    } catch {
      // Best-effort; TTL still propagates.
    }
  }
  await audit(db, actor, {
    action: "stage.canary_promote", resourceType: "stage", resourceId: stage.id,
    projectId, apiId: api.id,
    before: { deploymentId: from, canary },
    after: { deploymentId: next.deployment_id ?? deployment.id, canary: toCanaryView(next.canary ?? null) },
    requestId,
  });
  return {
    deploymentId: next.deployment_id ?? deployment.id,
    canary: toCanaryView(next.canary ?? null),
    mergedVariables: mergeVariables,
  };
}
