// Agent tool gateway config service (S13 part E).
//
// Opt-in per stage: `stages.agent_tools = { enabled, allowOperations[],
// auth: "passthrough" }`. `tools/list` derives one MCP tool per allowed
// operation; `tools/call` runs through the normal pipeline in-process (see
// `lib/gateway/distribution/mcp.mjs`). The gateway host serves
// `/{stage}/_mcp` (Streamable HTTP); this service owns the stage config
// (GET/PUT) plus the `agentTools` stack kind cell for declarative config.
//
// @module lib/control/agent-tools

import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { resolveApi } from "./apis.mjs";

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Cleans an agent-tools stage config.
 *
 * @param {unknown} input
 * @returns {{ enabled: boolean, allowOperations: Array<string>|null, auth: string }}
 */
export function cleanAgentTools(input) {
  if (input === null || input === undefined) return { enabled: false, allowOperations: null, auth: "passthrough" };
  if (!isObject(input)) throw new HttpError(422, "invalid_input", "Invalid request: $.agentTools: expected an object");
  const enabled = input.enabled === true;
  let allowOperations = null;
  if (input.allowOperations !== undefined && input.allowOperations !== null) {
    if (!Array.isArray(input.allowOperations)) {
      throw new HttpError(422, "invalid_input", "Invalid request: $.agentTools.allowOperations: expected an array");
    }
    allowOperations = input.allowOperations
      .filter((entry) => typeof entry === "string" && entry !== "")
      .map((entry) => entry.slice(0, 256))
      .slice(0, 512);
  }
  const auth = input.auth ?? "passthrough";
  if (auth !== "passthrough") {
    throw new HttpError(422, "invalid_input", 'Invalid request: $.agentTools.auth: must be "passthrough"');
  }
  return { enabled, allowOperations, auth };
}

function toView(stage) {
  return {
    stage: stage.name,
    agentTools: stage.agent_tools ?? stage.agentTools ?? { enabled: false, allowOperations: null, auth: "passthrough" },
  };
}

/** Get the agent-tools config for a stage. */
export async function getAgentTools(db, actor, { projectId, apiId, stageName }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.apis.view", { projectId });
  const stage = await db.getStageByName({ apiId: api.id, name: stageName }).catch(() => null);
  if (!stage) throw new HttpError(404, "not_found", "Stage does not exist.");
  return toView(stage);
}

/** Replace the agent-tools config for a stage (REST only). */
export async function putAgentTools(db, actor, { projectId, apiId, stageName, agentTools, requestId = null }) {
  const api = await resolveApi(db, projectId, apiId);
  if (api.protocol !== "REST") {
    throw new HttpError(400, "capability_unsupported", "Agent tools are only available on REST APIs.");
  }
  await requirePermission(db, actor, "pods.stage.write", { projectId, apiId: api.id });
  const stage = await db.getStageByName({ apiId: api.id, name: stageName }).catch(() => null);
  if (!stage) throw new HttpError(404, "not_found", "Stage does not exist.");
  const clean = cleanAgentTools(agentTools);
  const before = toView(stage);
  const next = await db.updateStage({ id: stage.id, patch: { agent_tools: clean, version: (stage.version ?? 1) + 1 } });
  await audit(db, actor, {
    action: "stage.agent_tools", resourceType: "stage", resourceId: stage.id,
    projectId, apiId: api.id, before, after: toView(next), requestId,
  });
  return toView(next);
}
