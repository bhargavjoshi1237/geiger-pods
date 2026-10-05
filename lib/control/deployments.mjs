/**
 * Deployments control-plane service (S05 §2–§3).
 *
 * `POST …/apis/{apiId}/deployments {description, stageName?, stageDescription?}`
 * loads the draft in one read, compiles via `lib/gateway/artifact`, and
 * inserts the immutable artifact. When `stageName` is given the stage pointer
 * moves in the same transaction (AWS `CreateDeployment` with `stageName`).
 *
 * Concurrency: an in-process per-API advisory lock plus a 1 deploy / 2 s
 * rate limit. A concurrent deploy gets 409 `deploy_in_progress`. When the
 * db port offers `advisoryLock(apiId)` (Postgres `pg_advisory_xact_lock`),
 * it is used as well; otherwise the in-process lock is the guard.
 *
 * @module lib/control/deployments
 */

import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { resolveApi } from "./apis.mjs";
import { compile } from "../gateway/artifact/compile.mjs";
import { newPublicId } from "../gateway/ids.mjs";
import { checkStageName, STAGE_CHANGED_CHANNEL } from "./stages.mjs";
import { validateStageVariables } from "../gateway/artifact/stage-variables.mjs";

/** In-process per-API deploy locks (plus rate-limit timestamps). */
const inProgress = new Set();
const lastDeployAt = new Map();
let clock = { now: () => Date.now() };

/** Test hook: inject a clock. */
export function setDeployClock(next) {
  clock = next ?? { now: () => Date.now() };
}

/** Test hook: reset locks and rate-limit state. */
export function resetDeployState() {
  inProgress.clear();
  lastDeployAt.clear();
  clock = { now: () => Date.now() };
  pendingAutoDeploys.clear();
  autoDeployFlags.clear();
}

function toView(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    apiId: row.api_id,
    publicId: row.public_id,
    description: row.description ?? "",
    digest: row.digest,
    schemaVersion: row.schema_version ?? 1,
    warnings: row.warnings ?? [],
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
  };
}

async function optionalList(db, method, args) {
  try {
    if (typeof db[method] !== "function") return [];
    const out = await db[method](args);
    if (Array.isArray(out)) return out;
    if (out && Array.isArray(out.items)) return out.items;
    return out ?? [];
  } catch (error) {
    if (error && (error.code === "42P01" || error.status === 501)) return [];
    throw error;
  }
}

async function loadDraft(db, api) {
  const [resources, methods, routes, integrations, models, validators, gatewayResponses, authorizers] = await Promise.all([
    (async () => {
      if (typeof db.listResourcesByApi === "function") return db.listResourcesByApi({ apiId: api.id });
      return optionalList(db, "listResources", { apiId: api.id, limit: 1000 });
    })(),
    (async () => {
      if (typeof db.listMethodsByApi === "function") return db.listMethodsByApi({ apiId: api.id });
      return [];
    })(),
    (async () => {
      if (typeof db.listRoutesByApi === "function") return db.listRoutesByApi({ apiId: api.id });
      return optionalList(db, "listRoutes", { apiId: api.id, limit: 1000 });
    })(),
    optionalList(db, "listIntegrations", { apiId: api.id, limit: 1000 }),
    optionalList(db, "listModels", { projectId: api.project_id, apiId: api.id }),
    optionalList(db, "listRequestValidators", { projectId: api.project_id, apiId: api.id }),
    optionalList(db, "listGatewayResponses", { projectId: api.project_id, apiId: api.id }),
    optionalList(db, "listAuthorizers", { apiId: api.id }),
  ]);
  return {
    projectId: api.project_id,
    apiId: api.id,
    apiPublicId: api.public_id,
    protocol: api.protocol,
    settings: {
      apiKeySource: api.api_key_source ?? "HEADER",
      binaryMediaTypes: api.binary_media_types ?? [],
      minimumCompressionSize: api.minimum_compression_size ?? null,
      missingRouteBehavior: api.missing_route_behavior ?? "aws",
      cors: api.cors ?? null,
      resourcePolicy: api.resource_policy ?? null,
      routeSelectionExpression: api.route_selection_expression ?? null,
    },
    resources,
    methods,
    routes,
    integrations,
    models,
    validators,
    gatewayResponses,
    authorizers,
  };
}

/**
 * Loads the draft for an API and compiles it without writing.
 *
 * @param {object} db
 * @param {object} api
 * @returns {Promise<{ artifact: object, warnings: Array }>}
 * @throws {HttpError} 422 with compile errors.
 */
export async function compileDraft(db, api) {
  const draft = await loadDraft(db, api);
  let compiled;
  try {
    compiled = compile(draft);
  } catch (error) {
    throw new HttpError(422, "invalid_config", error.message);
  }
  if (compiled.errors.length > 0) {
    throw new HttpError(422, "invalid_config", compiled.errors[0].message, { errors: compiled.errors });
  }
  return { artifact: compiled.artifact, warnings: compiled.warnings };
}

/** List deployments (newest first). */
export async function listDeployments(db, actor, { projectId, apiId, limit = 25, cursor = null }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.apis.view", { projectId });
  const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const rows = await db.listDeployments({ apiId: api.id, limit: take + 1, cursor });
  const page = rows.slice(0, take);
  return {
    items: page.map(toView),
    nextCursor: rows.length > take ? String(page[page.length - 1].id) : null,
  };
}

/** Get one deployment (artifact included for diff/rollback). */
export async function getDeployment(db, actor, { projectId, apiId, deploymentId }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.apis.view", { projectId });
  const row = await db.getDeploymentById(deploymentId);
  if (!row || row.api_id !== api.id) throw new HttpError(404, "not_found", "Deployment does not exist.");
  return { ...toView(row), artifact: row.artifact ?? null };
}

/**
 * Create a deployment. When `stageName` is given the stage is created or
 * moved in the same call (AWS parity).
 */
export async function createDeployment(db, actor, {
  projectId, apiId, description = "", stageName = null, stageDescription = "",
  requestId = null, kv = null,
}) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.deployment.create", { projectId, apiId: api.id });
  if (typeof description !== "string" || description.length > 1024) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.description: must be a string of at most 1024 characters");
  }
  let stage = null;
  if (stageName !== null && stageName !== undefined) {
    checkStageName(stageName, api.protocol);
    await requirePermission(db, actor, "pods.stage.write", { projectId, apiId: api.id });
  }

  const lockKey = api.id;
  if (inProgress.has(lockKey)) {
    throw new HttpError(409, "deploy_in_progress", "Another deployment for this API is in progress.");
  }
  const last = lastDeployAt.get(lockKey) ?? 0;
  if (clock.now() - last < 2000) {
    throw new HttpError(429, "deploy_rate_limited", "Deployments are limited to one per 2 seconds per API.");
  }
  if (typeof db.advisoryLock === "function") {
    const acquired = await db.advisoryLock({ apiId: api.id });
    if (acquired === false) {
      throw new HttpError(409, "deploy_in_progress", "Another deployment for this API is in progress.");
    }
  }
  inProgress.add(lockKey);
  try {
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
    lastDeployAt.set(lockKey, clock.now());
    if (stageName !== null && stageName !== undefined) {
      await requirePermission(db, actor, "pods.stage.promote", { projectId, apiId: api.id });
      const existing = await db.getStageByName({ apiId: api.id, name: stageName });
      if (!existing) {
        stage = await db.insertStage({
          project_id: projectId,
          api_id: api.id,
          name: stageName,
          deployment_id: row.id,
          description: stageDescription,
          variables: {},
          auto_deploy: false,
          created_by: actor?.userId ?? null,
        });
        await db.insertStageHistory({
          project_id: projectId,
          stage_id: stage.id,
          from_deployment_id: null,
          to_deployment_id: row.id,
          reason: "deploy",
          actor_id: actor?.userId ?? null,
        });
      } else {
        const from = existing.deployment_id ?? null;
        stage = await db.updateStage({ id: existing.id, patch: { deployment_id: row.id, version: existing.version + 1 } });
        await db.insertStageHistory({
          project_id: projectId,
          stage_id: existing.id,
          from_deployment_id: from,
          to_deployment_id: row.id,
          reason: "deploy",
          actor_id: actor?.userId ?? null,
        });
      }
      if (kv && typeof kv.publish === "function") {
        try {
          await kv.publish(STAGE_CHANGED_CHANNEL, JSON.stringify({ apiPublicId: api.public_id, stage: stageName }));
        } catch {
          // Best-effort; TTL still propagates.
        }
      }
    }
    await audit(db, actor, {
      action: "deployment.create", resourceType: "deployment", resourceId: row.id,
      projectId, apiId: api.id, before: null, after: toView(row), requestId,
    });
    return { status: 201, body: { ...toView(row), stage: stage ? stage.name : null } };
  } finally {
    inProgress.delete(lockKey);
  }
}

/** Delete a deployment (409 when a stage or canary references it). */
export async function deleteDeployment(db, actor, { projectId, apiId, deploymentId, requestId = null }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.stage.delete", { projectId, apiId: api.id });
  const row = await db.getDeploymentById(deploymentId);
  if (!row || row.api_id !== api.id) throw new HttpError(404, "not_found", "Deployment does not exist.");
  const stages = await db.listStages({ apiId: api.id });
  const referencing = stages.filter((stage) =>
    stage.deployment_id === row.id || stage.canary?.deploymentId === row.id || stage.canary?.deployment_id === row.id);
  if (referencing.length > 0) {
    const names = referencing.map((stage) => stage.name).join(", ");
    throw new HttpError(409, "deployment_in_use", `Deployment is referenced by stage(s): ${names}.`, { stages: referencing.map((stage) => stage.name) });
  }
  const before = toView(row);
  await db.deleteDeployment({ id: row.id });
  await audit(db, actor, {
    action: "deployment.delete", resourceType: "deployment", resourceId: row.id,
    projectId, apiId: api.id, before, after: null, requestId,
  });
  return { id: row.id, deleted: true };
}

function diffValue(a, b, path, out) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      diffValue(a[key], b[key], path ? `${path}.${key}` : key, out);
    }
    return;
  }
  out.push({ path, before: a ?? null, after: b ?? null });
}

/** Structural JSON diff between two deployment artifacts (for the UI). */
export async function diffDeployments(db, actor, { projectId, apiId, deploymentIdA, deploymentIdB }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.apis.view", { projectId });
  const [a, b] = await Promise.all([db.getDeploymentById(deploymentIdA), db.getDeploymentById(deploymentIdB)]);
  if (!a || a.api_id !== api.id || !b || b.api_id !== api.id) {
    throw new HttpError(404, "not_found", "Deployment does not exist.");
  }
  const changes = [];
  diffValue(a.artifact ?? {}, b.artifact ?? {}, "", changes);
  return { deploymentIdA: a.id, deploymentIdB: b.id, changes };
}

// --- Auto-deploy (HTTP/WS only) -------------------------------------------

/** Debounce timers per API (1 s). */
const pendingAutoDeploys = new Map();
const autoDeployFlags = new Map();

/**
 * Schedules an auto-deploy after a draft mutation. Debounces 1 s, then
 * compiles and deploys to every auto-deploy stage. On compile error live
 * traffic is untouched; the stage gets `last_deployment_status_message`
 * plus an audit entry. Runs in-process via `after()` from route handlers.
 *
 * @param {object} db - Control db (must support the releases tables).
 * @param {{ projectId: string, apiId: string, actor?: object, kv?: object }} options
 */
export function scheduleAutoDeploy(db, { projectId, apiId, actor = null, kv = null } = {}) {
  const key = `${projectId}:${apiId}`;
  if (pendingAutoDeploys.has(key)) clearTimeout(pendingAutoDeploys.get(key));
  const timer = setTimeout(() => {
    pendingAutoDeploys.delete(key);
    runAutoDeploy(db, { projectId, apiId, actor, kv }).catch(() => {});
  }, 1000);
  pendingAutoDeploys.get(key)?.unref?.();
  pendingAutoDeploys.set(key, timer);
  autoDeployFlags.set(key, true);
}

/**
 * Runs the pending auto-deploy immediately (tests + `after()` callbacks).
 */
export async function runAutoDeploy(db, { projectId, apiId, actor = null, kv = null } = {}) {
  const api = await db.getApiByRef({ projectId, ref: apiId }).catch(() => null);
  const resolved = api ?? await resolveApi(db, projectId, apiId).catch(() => null);
  if (!resolved) return null;
  if (resolved.protocol !== "HTTP" && resolved.protocol !== "WEBSOCKET") return null;
  const stages = await db.listStages({ apiId: resolved.id });
  const targets = stages.filter((stage) => stage.auto_deploy);
  if (targets.length === 0) return null;
  let compiled;
  try {
    compiled = await compileDraft(db, resolved);
  } catch (error) {
    const message = error.message ?? "Auto-deploy failed: draft does not compile.";
    for (const stage of targets) {
      await db.updateStage({ id: stage.id, patch: { last_deployment_status_message: message, version: stage.version + 1 } });
    }
    await db.insertAudit({
      project_id: projectId,
      actor_id: actor?.userId ?? null,
      actor_type: actor?.type ?? "system",
      action: "deployment.auto_deploy_failed",
      resource_type: "stage",
      resource_id: targets[0].id,
      api_id: resolved.id,
      before: null,
      after: { message },
      request_id: null,
    }).catch(() => {});
    return { status: "failed", message };
  }
  const row = await db.insertDeployment({
    id: randomUUID(),
    project_id: projectId,
    api_id: resolved.id,
    public_id: newPublicId().slice(0, 6),
    description: "auto-deploy",
    artifact: compiled.artifact,
    digest: compiled.artifact.digest,
    schema_version: 1,
    warnings: compiled.warnings,
    created_by: actor?.userId ?? null,
  });
  for (const stage of targets) {
    const from = stage.deployment_id ?? null;
    await db.updateStage({ id: stage.id, patch: { deployment_id: row.id, last_deployment_status_message: null, version: stage.version + 1 } });
    await db.insertStageHistory({
      project_id: projectId,
      stage_id: stage.id,
      from_deployment_id: from,
      to_deployment_id: row.id,
      reason: "auto_deploy",
      actor_id: actor?.userId ?? null,
    });
    if (kv && typeof kv.publish === "function") {
      try {
        await kv.publish(STAGE_CHANGED_CHANNEL, JSON.stringify({ apiPublicId: resolved.public_id, stage: stage.name }));
      } catch {
        // Best-effort.
      }
    }
  }
  return { status: "deployed", deploymentId: row.id };
}

/** Test hook: was an auto-deploy scheduled for this API? */
export function wasAutoDeployScheduled(projectId, apiId) {
  return autoDeployFlags.get(`${projectId}:${apiId}`) ?? false;
}

export { validateStageVariables };
