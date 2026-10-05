/**
 * Resource policies control-plane service (S07 §7, REST only).
 *
 * The policy document lives on the S03 `pods.apis.resource_policy` column
 * (≤ 8192 chars serialized) and is snapshotted into the deployment artifact
 * at compile time, so edits take effect on the next deployment (AWS
 * semantics). Reads need `pods.apis.view`; edits and simulation need
 * `pods.resource_policy.write`.
 *
 * Also exports the editor `POLICY_TEMPLATES` (IP allow-list, deny IP range,
 * connector-only private API, cross-project principal allow) and the
 * simulator used by the `.../resource-policy/simulate` route.
 *
 * `db` port: `getApiByRef({ projectId, ref })`, `updateApi({ id, patch })`.
 *
 * @module lib/control/resource-policies
 */

import { evaluateResourcePolicy, MAX_RESOURCE_POLICY_CHARS, validateResourcePolicy } from "../gateway/core/auth/resource-policy.mjs";
import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";

/**
 * Editor templates (placeholders in ALL_CAPS for the UI to fill in).
 *
 * @type {Record<string, { title: string, description: string, document(): object }>}
 */
export const POLICY_TEMPLATES = {
  ipAllowList: {
    title: "IP allow-list",
    description: "Allow invoke from two office ranges; everything else is implicitly denied.",
    document: () => ({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Action: "execute-api:Invoke",
        Resource: "arn:pods:execute-api:*",
        Condition: { IpAddress: { "aws:SourceIp": ["203.0.113.0/24", "198.51.100.0/24"] } },
      }],
    }),
  },
  denyIpRange: {
    title: "Deny IP range",
    description: "Explicitly deny one abusive range; all other callers fall through to the authorizer.",
    document: () => ({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Deny",
        Action: "execute-api:Invoke",
        Resource: "arn:pods:execute-api:*",
        Condition: { IpAddress: { "aws:SourceIp": "192.0.2.0/24" } },
      }],
    }),
  },
  connectorOnly: {
    title: "Connector-only private API",
    description: "Allow invoke only through one private connector (source VPC endpoint).",
    document: () => ({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Action: "execute-api:Invoke",
        Resource: "arn:pods:execute-api:*",
        Condition: { StringEquals: { "aws:SourceVpce": "CONNECTOR_ID" } },
      }],
    }),
  },
  crossProjectAllow: {
    title: "Cross-project principal allow",
    description: "Allow one foreign signing credential to invoke this API.",
    document: () => ({
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Action: "execute-api:Invoke",
        Resource: "arn:pods:execute-api:*",
        Principal: { Pods: ["arn:pods:iam::OTHER_PROJECT:credential/PKIAXXXXXXXXXXXXXXXX"] },
      }],
    }),
  },
};

async function resolveRestApi(db, projectId, apiRef) {
  const api = await db.getApiByRef({ projectId, ref: apiRef });
  if (!api) throw new HttpError(404, "not_found", "API does not exist.");
  if (api.protocol !== "REST") {
    throw new HttpError(400, "capability_unsupported", "Resource policies are only supported on REST APIs.");
  }
  return api;
}

function checkDocument(document) {
  if (document === null || document === undefined) return null;
  if (typeof document !== "object" || Array.isArray(document)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.document: expected a policy object or null");
  }
  let serialized;
  try {
    serialized = JSON.stringify(document);
  } catch {
    throw new HttpError(422, "invalid_input", "Invalid request: $.document: must be JSON-serializable");
  }
  if (serialized.length > MAX_RESOURCE_POLICY_CHARS) {
    throw new HttpError(422, "invalid_input", `Invalid request: $.document: must serialize to at most ${MAX_RESOURCE_POLICY_CHARS} characters`);
  }
  const { errors } = validateResourcePolicy(document);
  if (errors.length > 0) {
    throw new HttpError(422, "invalid_input", `Invalid policy: ${errors[0].path}: ${errors[0].message}`, { errors });
  }
  return document;
}

/** Get the current resource policy (`{ document }`, `null` when unset). */
export async function getResourcePolicy(db, actor, { projectId, apiId }) {
  const api = await resolveRestApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.apis.view", { projectId, apiId: api.id });
  return { document: api.resource_policy ?? null };
}

/**
 * Replace the resource policy (`document: null` clears it). Takes effect on
 * the next deployment. Compare-and-swap via `expectedVersion` (the API row
 * version).
 */
export async function updateResourcePolicy(db, actor, { projectId, apiId, document, expectedVersion = null, requestId = null }) {
  const api = await resolveRestApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.resource_policy.write", { projectId });
  if (expectedVersion !== null && api.version !== expectedVersion) {
    throw new HttpError(409, "version_conflict", `API changed (expected version ${expectedVersion}, found ${api.version}).`);
  }
  const clean = checkDocument(document);
  const before = { document: api.resource_policy ?? null };
  const updated = await db.updateApi({ id: api.id, patch: { resource_policy: clean, version: api.version + 1 } });
  await audit(db, actor, {
    action: "resource_policy.update", resourceType: "api", resourceId: api.id,
    projectId, apiId: api.id, before, after: { document: updated.resource_policy ?? null }, requestId,
  });
  return { document: updated.resource_policy ?? null, version: updated.version };
}

/**
 * Simulate a call (`methodArn`, `sourceIp`, `principalArn?`) against the
 * current draft policy. Returns `{ decision, matched }` where `matched`
 * lists the statements that fired (`{ effect, index }`).
 */
export async function simulateResourcePolicy(db, actor, { projectId, apiId, methodArn, sourceIp = "", principalArn = null }) {
  const api = await resolveRestApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.resource_policy.write", { projectId });
  if (typeof methodArn !== "string" || methodArn === "") {
    throw new HttpError(422, "invalid_input", "Invalid request: $.methodArn: must be a non-empty string");
  }
  const document = api.resource_policy ?? null;
  if (!document) return { decision: "ImplicitDeny", matched: [], note: "No resource policy is configured; nothing allows this call." };
  const { decision, matched } = evaluateResourcePolicy({
    document,
    resource: methodArn,
    request: { sourceIp: String(sourceIp ?? ""), nowMs: Date.now() },
    principalArn,
  });
  return { decision, matched };
}
