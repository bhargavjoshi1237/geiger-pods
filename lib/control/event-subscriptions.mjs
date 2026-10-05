// Management event webhooks (S14 §6, EventBridge equivalent).
//
// `pods.event_subscriptions` fan out audit actions (`deployment.create`,
// `stage.update`, `api_key.create`, …) to HTTPS targets. Deliveries are
// HMAC-signed (`x-pods-signature`, same scheme as S04 webhook functions),
// retried with backoff for 24 h, and recorded in `pods.event_deliveries`.

import { createHmac, randomUUID } from "node:crypto";
import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";

const MAX_ATTEMPTS = 25;
const RETRY_CAP_MS = 3600 * 1000;

/**
 * Computes the delivery signature: `t=<unix>,v1=<hex hmac-sha256>`.
 *
 * @param {string} secret
 * @param {string} body
 * @param {number} [nowSec]
 * @returns {string}
 */
export function signEventBody(secret, body, nowSec = Math.floor(Date.now() / 1000)) {
  const digest = createHmac("sha256", secret).update(`${nowSec}.${body}`, "utf8").digest("hex");
  return `t=${nowSec},v1=${digest}`;
}

function checkSubscription(input, { partial = false } = {}) {
  const out = {};
  if (input.name !== undefined || !partial) {
    if (typeof input.name !== "string" || input.name.length < 1 || input.name.length > 128) {
      throw new HttpError(422, "invalid_input", "name must be 1–128 characters.");
    }
    out.name = input.name;
  }
  if (input.eventTypes !== undefined || !partial) {
    if (!Array.isArray(input.eventTypes) || input.eventTypes.length === 0) {
      throw new HttpError(422, "invalid_input", "eventTypes must be a non-empty array.");
    }
    out.event_types = input.eventTypes.map(String);
  }
  if (input.targetUrl !== undefined || !partial) {
    try {
      const url = new URL(input.targetUrl);
      if (url.protocol !== "https:") throw new Error("https only");
      out.target_url = input.targetUrl;
    } catch {
      throw new HttpError(422, "invalid_input", "targetUrl must be an https URL.");
    }
  }
  if (input.secretRef !== undefined || !partial) {
    if (typeof input.secretRef !== "string" || !input.secretRef.startsWith("secret:")) {
      throw new HttpError(422, "invalid_input", "secretRef must reference a secret (secret:<id>).");
    }
    out.secret_ref = input.secretRef;
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new HttpError(422, "invalid_input", "enabled must be a boolean.");
    out.enabled = input.enabled;
  } else if (!partial) {
    out.enabled = true;
  }
  return out;
}

/** List event subscriptions. */
export async function listSubscriptions(db, actor, { projectId }) {
  await requirePermission(db, actor, "pods.export.write", { projectId });
  return db.listEventSubscriptions({ projectId });
}

/** Create an event subscription. The signing secret stays a vault ref. */
export async function createSubscription(db, actor, { projectId, input, requestId = null }) {
  await requirePermission(db, actor, "pods.export.write", { projectId });
  if (input.secretRef) await requirePermission(db, actor, "pods.secret.use", { projectId });
  const clean = checkSubscription(input);
  const row = await db.insertEventSubscription({ project_id: projectId, ...clean });
  await audit(db, actor, {
    action: "event_subscription.create", resourceType: "event_subscription", resourceId: row.id,
    projectId, before: null, after: { id: row.id, name: clean.name }, requestId,
  });
  return row;
}

/** Delete an event subscription. */
export async function deleteSubscription(db, actor, { projectId, subscriptionId, requestId = null }) {
  await requirePermission(db, actor, "pods.export.write", { projectId });
  const existing = await db.getEventSubscription({ id: subscriptionId });
  if (!existing || existing.project_id !== projectId) {
    throw new HttpError(404, "not_found", "Event subscription does not exist.");
  }
  await db.deleteEventSubscription({ id: subscriptionId });
  await audit(db, actor, {
    action: "event_subscription.delete", resourceType: "event_subscription", resourceId: subscriptionId,
    projectId, before: { id: subscriptionId, name: existing.name }, after: null, requestId,
  });
  return { id: subscriptionId, deleted: true };
}

/**
 * Fan-out for one audit event: creates a delivery per matching enabled
 * subscription. Called by the audit dispatcher job, not the request path.
 *
 * @param {object} db - Needs `listEventSubscriptionsFor`, `insertEventDelivery`.
 * @param {{ id?: string, action: string, projectId: string, apiId?: string|null, resourceType?: string|null, resourceId?: string|null, at?: string }} event
 */
export async function fanOut(db, event) {
  const matches = await db.listEventSubscriptionsFor({ projectId: event.projectId, eventType: event.action });
  const deliveries = [];
  for (const sub of matches ?? []) {
    if (sub.enabled === false) continue;
    const delivery = await db.insertEventDelivery({
      project_id: event.projectId, subscription_id: sub.id, event_type: event.action,
      event_id: event.id ?? randomUUID(), status: "pending", attempts: 0,
      next_attempt_at: new Date().toISOString(),
    });
    deliveries.push(delivery);
  }
  return deliveries;
}

/**
 * Attempts one delivery. Success marks it delivered; failure schedules the
 * next attempt with backoff (up to 24 h total), then marks it failed.
 */
export async function attemptDelivery(db, ports, delivery) {
  const sub = await db.getEventSubscription({ id: delivery.subscription_id });
  if (!sub || sub.enabled === false) {
    await db.updateEventDelivery({ id: delivery.id, status: "failed", last_error: "subscription gone" });
    return { delivered: false };
  }
  const secret = await ports.secrets.resolve(sub.secret_ref).then(
    (resolved) => typeof resolved?.value === "string" ? resolved.value : resolved?.value?.value ?? null,
    () => null,
  );
  if (!secret) {
    await db.updateEventDelivery({ id: delivery.id, status: "failed", last_error: "unresolvable secret" });
    return { delivered: false };
  }
  const body = JSON.stringify({
    id: delivery.event_id, type: delivery.event_type, projectId: delivery.project_id,
    at: delivery.created_at ?? new Date().toISOString(),
  });
  const signature = signEventBody(secret, body);
  try {
    const fetchImpl = ports.fetch ?? globalThis.fetch;
    const response = await fetchImpl(sub.target_url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pods-signature": signature },
      body, redirect: "manual", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`target responded ${response.status}`);
    await db.updateEventDelivery({ id: delivery.id, status: "delivered", attempts: (delivery.attempts ?? 0) + 1 });
    return { delivered: true };
  } catch (error) {
    const attempts = (delivery.attempts ?? 0) + 1;
    const ageMs = Date.now() - new Date(delivery.created_at ?? Date.now()).getTime();
    if (attempts >= MAX_ATTEMPTS || ageMs > 24 * 3600 * 1000) {
      await db.updateEventDelivery({ id: delivery.id, status: "failed", attempts, last_error: error?.message ?? "delivery failed" });
      return { delivered: false };
    }
    const backoffMs = Math.min(RETRY_CAP_MS, 5000 * 2 ** Math.min(attempts, 8));
    await db.updateEventDelivery({
      id: delivery.id, status: "pending", attempts,
      next_attempt_at: new Date(Date.now() + backoffMs).toISOString(),
      last_error: error?.message ?? "delivery failed",
    });
    return { delivered: false };
  }
}
