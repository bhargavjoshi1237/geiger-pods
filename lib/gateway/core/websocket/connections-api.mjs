/**
 * `@connections` runtime API: POST/GET/DELETE with SIGNED
 * `execute-api:ManageConnections` (S12 §4).
 *
 * Paths: `/{stage}/@connections/{connectionId}` on the default host and on
 * custom domains through their mappings. POST bodies ≤ 128 KB; binary when
 * `Content-Type: application/octet-stream`.
 *
 * @module lib/gateway/core/websocket/connections-api
 */

import { verifySignature } from "../auth/sigv4.mjs";
import { buildMethodArn, credentialPrincipalArn, evaluatePolicy } from "../auth/policy.mjs";
import { evaluateResourcePolicy } from "../auth/resource-policy.mjs";
import { GatewayError } from "../errors.mjs";
import { MAX_MESSAGE_BYTES } from "./constants.mjs";
import { getConnection } from "./registry.mjs";

/**
 * Verifies a ManageConnections SigV4 request.
 *
 * Only `execute-api:ManageConnections` identity statements count (F40: the
 * old `execute-api:Invoke` fallback is removed — AWS requires
 * ManageConnections for `@connections`). Cross-project callers additionally
 * need an explicit Allow in the API's resource policy (F39); the
 * credential's own identity Allow is never sufficient on its own, and the
 * principal ARN names the credential's own project.
 *
 * @param {Request} request
 * @param {{ artifact: object, stage: string, connectionId: string, method: string, ports: object }} input
 * @throws {GatewayError} 403 on unsigned/denied.
 */
export async function authorizeManageConnections(request, { artifact, stage, connectionId, method, ports }) {
  const lookup = ports?.signingCredentials ?? null;
  const verified = await verifySignature(request, {
    region: artifact?.region ?? "auto",
    allowAnyRegion: artifact?.features?.signedAnyRegion === true,
    lookupSecret: lookup ? async (id) => lookup.resolve(id) : async () => null,
    now: ports?.clock?.now?.(),
  }).catch((error) => {
    throw new GatewayError("ACCESS_DENIED", error?.message ?? "Forbidden");
  });
  // F39: principal ARN from the credential's own project, never the API's.
  const credentialProject = verified.credential?.projectId ?? artifact?.projectId ?? "";
  const principalArn = credentialPrincipalArn({ projectId: credentialProject, accessKeyId: verified.accessKeyId });
  const crossProject = credentialProject !== "" && credentialProject !== (artifact?.projectId ?? "");
  const resource = buildMethodArn({
    region: artifact?.region ?? "auto",
    projectId: artifact?.projectId ?? "",
    apiPublicId: artifact?.apiPublicId ?? artifact?.apiId ?? "",
    stage,
    method: String(method).toUpperCase(),
    resourcePath: `@connections/${connectionId}`,
  });
  const policies = ports?.signingPolicies ?? null;
  if (!policies) {
    // No policy port (tests): a valid signature suffices same-project only.
    if (crossProject) throw new GatewayError("ACCESS_DENIED", "Forbidden");
    return { accessKeyId: verified.accessKeyId, principalArn };
  }
  const documents = (await policies.list(verified.accessKeyId)) ?? [];
  let allowed = false;
  for (const document of documents) {
    const { decision } = evaluatePolicy({
      document,
      action: "execute-api:ManageConnections",
      resource,
      request: { sourceIp: "", principalArn, nowMs: ports?.clock?.now?.() ?? Date.now() },
    });
    if (decision === "Deny") throw new GatewayError("ACCESS_DENIED", "Forbidden");
    if (decision === "Allow") allowed = true;
  }
  if (!allowed) throw new GatewayError("ACCESS_DENIED", "Forbidden");
  // F39: cross-project callers need an explicit Allow in the API's resource
  // policy naming this principal; identity Allow alone is insufficient.
  if (crossProject) {
    const document = artifact?.settings?.resourcePolicy ?? null;
    if (!document) throw new GatewayError("ACCESS_DENIED", "Forbidden");
    const { decision } = evaluateResourcePolicy({
      document,
      action: "execute-api:Invoke",
      resource,
      request: { sourceIp: "", principalArn, nowMs: ports?.clock?.now?.() ?? Date.now() },
      principalArn,
    });
    if (decision !== "Allow") throw new GatewayError("ACCESS_DENIED", "Forbidden");
  }
  return { accessKeyId: verified.accessKeyId, principalArn };
}

/**
 * Parses an `@connections` path from a stripped path.
 *
 * @param {string} strippedPath - e.g. `/prod/@connections/abc`.
 * @returns {{ stage: string, connectionId: string }|null}
 */
export function parseConnectionsPath(strippedPath) {
  const segments = String(strippedPath ?? "").split("/").filter(Boolean);
  // `{stage}/@connections/{id}` — stage is resolved by the loader; here the
  // stripped path no longer has the stage, so accept `@connections/{id}`.
  if (segments.length >= 2 && segments[0] === "@connections") {
    return { stage: "", connectionId: segments[1] ?? "" };
  }
  return null;
}

/**
 * Validates a POST body size (≤ 128 KB).
 *
 * @param {Uint8Array|null} body
 * @throws {GatewayError} 413 when too large.
 */
export function assertPostBodySize(body) {
  const size = body?.byteLength ?? 0;
  if (size > MAX_MESSAGE_BYTES) throw new GatewayError("REQUEST_TOO_LARGE", "Request Too Long");
}
