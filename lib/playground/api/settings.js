// Playground fake for the v1 API: Project settings, team access (role grants), access tokens, stacks, tags, signing credentials, client certificates.
// Served so far: resource tags (lib/control/tags.mjs) and client certificates
// (lib/control/client-certificates.mjs).

import { PROJECT_ID, ACTOR_ID, audit, bodyOf, byOldest, fail, live, newId, nowIso, routes, table } from "./http.js";

// --- Tags ----------------------------------------------------------------------

// lib/control/tags.mjs TAGGABLE_TYPES / MAX_TAGS_PER_RESOURCE / key rules.
const TAGGABLE_TYPES = new Set([
  "api", "stage", "api_key", "usage_plan", "domain", "connector", "client_certificate", "web_acl", "portal",
  "portal_product", "secret", "signing_credential",
]);
const MAX_TAGS_PER_RESOURCE = 50;
const KEY_PATTERN = /^[\p{L}\p{Z}\p{N}_.:/=+\-@]{1,128}$/u;

function checkType(resourceType) {
  if (!TAGGABLE_TYPES.has(resourceType)) {
    fail(422, "invalid_input", `Invalid resource type "${resourceType}". Taggable: ${[...TAGGABLE_TYPES].join(", ")}.`);
  }
}

function checkTag(key, value) {
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
    fail(422, "invalid_input", `Invalid tag key "${key}". Keys are 1–128 chars of letters, numbers, whitespace, _ . : / = + - @.`);
  }
  if (key.toLowerCase().startsWith("aws:") || key.toLowerCase().startsWith("pods:")) {
    fail(422, "invalid_input", `Tag key "${key}" uses a reserved prefix (aws:, pods:).`);
  }
  if (typeof value !== "string" || value.length > 256) {
    fail(422, "invalid_input", `Invalid tag value for "${key}". Values are at most 256 chars.`);
  }
}

function tagRows({ resourceType, resourceId }) {
  return table("tags").filter((row) => row.resource_type === resourceType && row.resource_id === resourceId);
}

function tagMap(rows) {
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function replaceTags(params, entries) {
  const rows = table("tags");
  for (const row of tagRows(params)) rows.splice(rows.indexOf(row), 1);
  const now = nowIso();
  for (const [key, value] of entries) {
    rows.push({
      id: newId(), project_id: PROJECT_ID, resource_type: params.resourceType, resource_id: params.resourceId,
      key, value, created_by: ACTOR_ID, created_at: now, updated_at: now,
    });
  }
}

function getTags({ params }) {
  checkType(params.resourceType);
  return tagMap(tagRows(params));
}

function putTags(ctx) {
  const { params } = ctx;
  checkType(params.resourceType);
  const body = bodyOf(ctx);
  const tags = body.tags ?? body;
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) fail(422, "invalid_input", "Provide tags as a key→value object.");
  const entries = Object.entries(tags);
  if (entries.length > MAX_TAGS_PER_RESOURCE) fail(422, "invalid_input", `At most ${MAX_TAGS_PER_RESOURCE} tags per resource.`);
  for (const [key, value] of entries) checkTag(key, value);
  const before = tagMap(tagRows(params));
  replaceTags(params, entries);
  const after = Object.fromEntries(entries);
  audit({ action: "tags.update", resourceType: params.resourceType, resourceId: params.resourceId, before, after });
  return after;
}

function deleteTags({ params }) {
  checkType(params.resourceType);
  const before = tagMap(tagRows(params));
  replaceTags(params, []);
  audit({ action: "tags.delete", resourceType: params.resourceType, resourceId: params.resourceId, before });
  return { deleted: true };
}

// --- Client certificates -----------------------------------------------------------

// Copy of lib/control/client-certificates.mjs certView().
function toCertificateView(row) {
  return {
    id: row.id, projectId: row.project_id, publicId: row.public_id, description: row.description ?? null,
    certificatePem: row.certificate_pem, expiresAt: row.expires_at, createdAt: row.created_at, version: row.version,
  };
}

function findCertificate(certificateId) {
  const row = live("client_certificates", (certificate) => certificate.id === certificateId)[0];
  if (!row) fail(404, "not_found", "Client certificate does not exist.");
  return row;
}

export const settingsRoutes = routes([
  ["GET", "/tags/:resourceType/:resourceId", getTags],
  ["PUT", "/tags/:resourceType/:resourceId", putTags],
  ["DELETE", "/tags/:resourceType/:resourceId", deleteTags],
  ["GET", "/client-certificates", () => ({ items: live("client_certificates").sort(byOldest).map(toCertificateView) })],
  ["GET", "/client-certificates/:certificateId", ({ params }) => toCertificateView(findCertificate(params.certificateId))],
]);
