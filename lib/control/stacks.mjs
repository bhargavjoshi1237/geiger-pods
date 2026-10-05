// Declarative stacks (S14 §4, CloudFormation/SAM equivalent).
//
// `pods.yaml` (parsed to JSON by the caller — the `yaml` package is already
// a dependency) describes desired state. The server diffs it against live
// resources tagged `pods:stack = <stack>`, using `name` as stable identity,
// and returns ordered operations. `apply` executes in dependency order;
// each step is idempotent, failures stop the run, and re-running converges.
//
// Resource kinds plug in via `registerStackHandler(kind, { plan, apply })`
// so specs landing later (S08 plans, S11 domains, S13 portals) extend
// stacks without editing this file. S14 ships the `api` kind.

import { createHash } from "node:crypto";
import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";

export const STACK_TAG = "pods:stack";

const HANDLERS = new Map();

/**
 * Registers a stack resource-kind handler. `plan` returns an array of ops;
 * `apply` executes one op and returns `{ applied: boolean }`.
 */
export function registerStackHandler(kind, handler) {
  if (typeof kind !== "string" || !handler || typeof handler.plan !== "function" || typeof handler.apply !== "function") {
    throw new TypeError("registerStackHandler(kind, { plan, apply }) requires functions.");
  }
  HANDLERS.set(kind, handler);
}

/** Stable hash of a stack file (change detection). */
export function hashStackFile(file) {
  return createHash("sha256").update(JSON.stringify(file ?? null), "utf8").digest("hex");
}

function checkFile(file) {
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    throw new HttpError(422, "invalid_input", "Stack file must be an object.");
  }
  if (file.version !== 1) {
    throw new HttpError(422, "invalid_input", "Stack file version must be 1.");
  }
  if (typeof file.stack !== "string" || file.stack === "") {
    throw new HttpError(422, "invalid_input", "Stack file requires a stack name.");
  }
  for (const secret of file.secrets ?? []) {
    if (secret && typeof secret === "object" && ("value" in secret || "secretValue" in secret)) {
      throw new HttpError(422, "invalid_input", `Secret "${secret.name}" must not carry a value in the file; set it with \`pods secrets set\`.`);
    }
  }
  return file;
}

/**
 * Computes the plan for a stack file. Returns `{ stack, hash, changes }`
 * where each change is `{ kind, name, op, diff?, identity }`.
 */
export async function planStack(db, actor, { projectId, stack, file, prune = false }) {
  await requirePermission(db, actor, "pods.api.create", { projectId });
  const clean = checkFile(file);
  if (clean.stack !== stack) {
    throw new HttpError(422, "invalid_input", `Stack file names "${clean.stack}" but the route targets "${stack}".`);
  }
  const changes = [];
  const liveTagged = await db.listStackResources({ projectId, stack }).catch(() => ({ apis: [] }));
  for (const [kind, handler] of HANDLERS) {
    const desired = kind === "api" ? (clean.apis ?? []) : (clean[kind] ?? clean[`${kind}s`] ?? []);
    const planned = await handler.plan(db, { projectId, stack, desired, live: liveTagged[kind] ?? liveTagged[`${kind}s`] ?? [], prune });
    for (const op of planned) {
      if (op.op === "noop") continue;
      changes.push({ kind, ...op });
    }
  }
  return { stack, hash: hashStackFile(clean), changes };
}

/**
 * Applies a planned (or freshly computed) change set in dependency order:
 * registration order of handlers. Stops at the first failure, records
 * progress on the stack row, and is re-runnable.
 */
export async function applyStack(db, actor, { projectId, stack, file = null, changes = null, prune = false, requestId = null }) {
  await requirePermission(db, actor, "pods.api.create", { projectId });
  const planned = changes ?? (await planStack(db, actor, { projectId, stack, file, prune })).changes;
  const applied = [];
  try {
    for (const change of planned) {
      if (change.op === "noop") continue;
      if (change.op === "delete" && !prune) {
        change.skipped = "needs_prune";
        continue;
      }
      const handler = HANDLERS.get(change.kind);
      if (!handler) throw new HttpError(501, "not_implemented", `No stack handler for kind "${change.kind}".`);
      await handler.apply(db, actor, { projectId, stack, change, requestId });
      applied.push(change);
    }
  } catch (error) {
    await db.upsertStack({ project_id: projectId, name: stack, status: "failed", last_error: error?.message ?? "apply failed" }).catch(() => null);
    await audit(db, actor, {
      action: "stack.apply", resourceType: "stack", resourceId: stack, projectId,
      before: null, after: { stack, status: "failed", applied: applied.length }, requestId,
    });
    throw error;
  }
  await db.upsertStack({
    project_id: projectId, name: stack, status: "applied",
    last_applied_hash: file ? hashStackFile(checkFile(file)) : null, last_error: null,
  }).catch(() => null);
  await audit(db, actor, {
    action: "stack.apply", resourceType: "stack", resourceId: stack, projectId,
    before: null, after: { stack, status: "applied", applied: applied.length }, requestId,
  });
  return { stack, applied, failed: null };
}

/** Drift = live resources tagged with the stack that differ from the file. */
export async function driftStack(db, actor, { projectId, stack, file }) {
  const planned = await planStack(db, actor, { projectId, stack, file, prune: true });
  const record = await db.getStack({ projectId, name: stack }).catch(() => null);
  return {
    stack,
    lastAppliedHash: record?.last_applied_hash ?? null,
    lastAppliedAt: record?.last_applied_at ?? null,
    status: record?.status ?? "idle",
    fileHash: planned.hash,
    inSync: planned.changes.length === 0,
    changes: planned.changes,
  };
}

// --- Built-in `api` kind (S02/S03 tables, S05-agnostic fields only) --------

function diffFields(before, after, fields) {
  const diff = {};
  for (const field of fields) {
    const left = before?.[field] ?? null;
    const right = after?.[field] ?? null;
    if (JSON.stringify(left) !== JSON.stringify(right)) diff[field] = { before: left, after: right };
  }
  return diff;
}

registerStackHandler("api", {
  async plan(db, { projectId, desired, live, prune }) {
    const ops = [];
    const liveByName = new Map((live ?? []).map((row) => [row.name, row]));
    const desiredNames = new Set();
    for (const entry of desired ?? []) {
      if (!entry || typeof entry.name !== "string" || entry.name === "") {
        throw new HttpError(422, "invalid_input", "Each apis[] entry requires a name.");
      }
      if (entry.protocol && !["REST", "HTTP", "WEBSOCKET"].includes(entry.protocol)) {
        throw new HttpError(422, "invalid_input", `API "${entry.name}" has unknown protocol "${entry.protocol}".`);
      }
      desiredNames.add(entry.name);
      const current = liveByName.get(entry.name);
      if (!current) {
        ops.push({ name: entry.name, op: "create", identity: { name: entry.name }, diff: { after: entry } });
        continue;
      }
      const diff = diffFields(
        { description: current.description ?? "", settings: current.settings ?? {} },
        { description: entry.description ?? "", settings: entry.settings ?? {} },
        ["description", "settings"],
      );
      ops.push({
        name: entry.name, op: Object.keys(diff).length === 0 ? "noop" : "update",
        identity: { name: entry.name, id: current.id }, diff,
      });
    }
    for (const row of live ?? []) {
      if (!desiredNames.has(row.name)) {
        ops.push({
          name: row.name, op: "delete", identity: { name: row.name, id: row.id },
          diff: { before: row }, ...(prune ? {} : { skipped: "needs_prune" }),
        });
      }
    }
    return ops;
  },
  async apply(db, actor, { projectId, stack, change }) {
    if (change.op === "create") {
      const created = await db.stackCreateApi({ project_id: projectId, name: change.name, file: change.diff?.after ?? {} });
      await db.tagStackResource({ project_id: projectId, stack, resource_type: "api", resource_id: created?.id ?? change.name }).catch(() => null);
      return { applied: true };
    }
    if (change.op === "update") {
      await db.stackUpdateApi({ project_id: projectId, id: change.identity?.id, name: change.name, file: change.diff?.after ?? {} });
      return { applied: true };
    }
    if (change.op === "delete") {
      await db.stackDeleteApi({ project_id: projectId, id: change.identity?.id, name: change.name });
      return { applied: true };
    }
    return { applied: false };
  },
});
