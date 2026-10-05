// Resource tags (S14 §5). One generic table keyed by
// (project_id, resource_type, resource_id) so specs landing later need no
// schema change. Taggable types mirror AWS cost-allocation use.

import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";

export const TAGGABLE_TYPES = new Set([
  "api", "stage", "api_key", "usage_plan", "domain", "connector",
  "client_certificate", "web_acl", "portal", "portal_product", "secret",
  "signing_credential",
]);

export const MAX_TAGS_PER_RESOURCE = 50;

const KEY_PATTERN = /^[\p{L}\p{Z}\p{N}_.:/=+\-@]{1,128}$/u;

function checkType(resourceType) {
  if (!TAGGABLE_TYPES.has(resourceType)) {
    throw new HttpError(422, "invalid_input", `Invalid resource type "${resourceType}". Taggable: ${[...TAGGABLE_TYPES].join(", ")}.`);
  }
  return resourceType;
}

function checkTag(key, value) {
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
    throw new HttpError(422, "invalid_input", `Invalid tag key "${key}". Keys are 1–128 chars of letters, numbers, whitespace, _ . : / = + - @.`);
  }
  if (key.toLowerCase().startsWith("aws:") || key.toLowerCase().startsWith("pods:")) {
    throw new HttpError(422, "invalid_input", `Tag key "${key}" uses a reserved prefix (aws:, pods:).`);
  }
  if (typeof value !== "string" || value.length > 256) {
    throw new HttpError(422, "invalid_input", `Invalid tag value for "${key}". Values are at most 256 chars.`);
  }
  return { key, value };
}

/**
 * Parses `?tag:Key=Value` filters from a URL's query string.
 *
 * @param {URLSearchParams} params
 * @returns {Array<{ key: string, value: string }>}
 */
export function parseTagFilters(params) {
  const out = [];
  for (const [name, value] of params ?? []) {
    if (name.startsWith("tag:")) out.push({ key: name.slice(4), value });
  }
  return out;
}

/**
 * True when a `tags` object satisfies every `?tag:Key=Value` filter (F26).
 * An empty filter list matches everything.
 */
export function matchesTagFilters(tags, filters) {
  if (!filters || filters.length === 0) return true;
  const map = tags ?? {};
  return filters.every(({ key, value }) => map[key] === value);
}

/**
 * Resolve the effective tags for one resource: the row's jsonb `tags`
 * merged with the generic `pods.tags` rows (when the db port offers
 * `listTags`). Generic rows win on key collision; both stores are treated
 * as one tag set for `?tag:` filtering (F26).
 */
export async function resolveResourceTags(db, { projectId, resourceType, resourceId, rowTags }) {
  const merged = { ...(rowTags ?? {}) };
  if (db && typeof db.listTags === "function") {
    try {
      const rows = await db.listTags({ projectId, resourceType, resourceId });
      for (const entry of rows ?? []) merged[entry.key] = entry.value;
    } catch {
      // Generic tags are best-effort; the jsonb column still filters.
    }
  }
  return merged;
}

/** GET all tags for one resource. */
export async function getTags(db, actor, { projectId, resourceType, resourceId }) {
  await requirePermission(db, actor, "pods.apis.view", { projectId });
  checkType(resourceType);
  const rows = await db.listTags({ projectId, resourceType, resourceId });
  return Object.fromEntries((rows ?? []).map((row) => [row.key, row.value]));
}

/**
 * PUT (replace) the full tag set for one resource. `tags` is a key→value
 * object. Enforces the 50-tag cap and key/value rules.
 */
export async function putTags(db, actor, { projectId, resourceType, resourceId, tags, requestId = null }) {
  await requirePermission(db, actor, "pods.api.update", { projectId });
  checkType(resourceType);
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) {
    throw new HttpError(422, "invalid_input", "Provide tags as a key→value object.");
  }
  const entries = Object.entries(tags);
  if (entries.length > MAX_TAGS_PER_RESOURCE) {
    throw new HttpError(422, "invalid_input", `At most ${MAX_TAGS_PER_RESOURCE} tags per resource.`);
  }
  const clean = entries.map(([key, value]) => checkTag(key, value));
  const before = await db.listTags({ projectId, resourceType, resourceId });
  await db.replaceTags({ project_id: projectId, resource_type: resourceType, resource_id: resourceId, tags: clean });
  await audit(db, actor, {
    action: "tags.update", resourceType, resourceId, projectId,
    before: Object.fromEntries((before ?? []).map((row) => [row.key, row.value])),
    after: Object.fromEntries(clean.map((entry) => [entry.key, entry.value])), requestId,
  });
  return Object.fromEntries(clean.map((entry) => [entry.key, entry.value]));
}

/** DELETE all tags for one resource. */
export async function deleteTags(db, actor, { projectId, resourceType, resourceId, requestId = null }) {
  await requirePermission(db, actor, "pods.api.update", { projectId });
  checkType(resourceType);
  const before = await db.listTags({ projectId, resourceType, resourceId });
  await db.replaceTags({ project_id: projectId, resource_type: resourceType, resource_id: resourceId, tags: [] });
  await audit(db, actor, {
    action: "tags.delete", resourceType, resourceId, projectId,
    before: Object.fromEntries((before ?? []).map((row) => [row.key, row.value])), after: null, requestId,
  });
  return { deleted: true };
}
