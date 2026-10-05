import assert from "node:assert/strict";
import test from "node:test";
import {
  createSubscription, deleteSubscription, fanOut, attemptDelivery, signEventBody,
} from "../../lib/control/event-subscriptions.mjs";

const PROJECT = "55555555-5555-5555-8555-555555555555";

function eventDb() {
  const store = { subs: new Map(), deliveries: new Map(), audits: [], n: 0 };
  return {
    store,
    async getInheritedRole() { return "admin"; },
    async listRoleBindings() { return { roles: [], grants: [] }; },
    async insertAudit(entry) { store.audits.push(entry); },
    async listEventSubscriptions({ projectId }) {
      return [...store.subs.values()].filter((row) => row.project_id === projectId);
    },
    async listEventSubscriptionsFor({ projectId, eventType }) {
      return [...store.subs.values()].filter((row) => row.project_id === projectId && (row.event_types ?? []).includes(eventType));
    },
    async insertEventSubscription(row) {
      const saved = { id: `sub-${++store.n}`, created_at: new Date().toISOString(), ...row };
      store.subs.set(saved.id, saved);
      return saved;
    },
    async getEventSubscription({ id }) { return store.subs.get(id) ?? null; },
    async deleteEventSubscription({ id }) { store.subs.delete(id); },
    async insertEventDelivery(row) {
      const saved = { id: `dlv-${++store.n}`, created_at: new Date().toISOString(), ...row };
      store.deliveries.set(saved.id, saved);
      return saved;
    },
    async updateEventDelivery(patch) {
      Object.assign(store.deliveries.get(patch.id), patch);
      return store.deliveries.get(patch.id);
    },
  };
}

const ADMIN = { type: "user", userId: "u" };

test("S14: event subscription receives signed deployment.create webhook", async () => {
  const db = eventDb();
  await assert.rejects(
    createSubscription(db, ADMIN, { projectId: PROJECT, input: { name: "x", eventTypes: ["deployment.create"], targetUrl: "http://insecure.example.com/hook", secretRef: "secret:1" } }),
    (error) => error.status === 422,
  );
  const sub = await createSubscription(db, ADMIN, {
    projectId: PROJECT,
    input: { name: "deploys", eventTypes: ["deployment.create"], targetUrl: "https://hooks.example.com/pods", secretRef: "secret:1" },
  });
  assert.equal(sub.enabled, true);

  const deliveries = await fanOut(db, { id: "evt-1", action: "deployment.create", projectId: PROJECT });
  assert.equal(deliveries.length, 1);
  const other = await fanOut(db, { id: "evt-2", action: "stage.update", projectId: PROJECT });
  assert.equal(other.length, 0);

  let seen = null;
  const ports = {
    fetch: async (url, init) => {
      seen = { url, signature: init.headers["x-pods-signature"], body: init.body };
      return new Response("ok", { status: 200 });
    },
    secrets: { async resolve() { return { value: "hook-secret" }; } },
  };
  const result = await attemptDelivery(db, ports, deliveries[0]);
  assert.equal(result.delivered, true);
  assert.equal(seen.url, "https://hooks.example.com/pods");
  assert.match(seen.signature, /^t=\d+,v1=[0-9a-f]{64}$/);
  const parsed = JSON.parse(seen.body);
  assert.equal(parsed.type, "deployment.create");

  // Failing target → pending with backoff, then failed after budget.
  const failing = { ...ports, fetch: async () => new Response("bad", { status: 500 }) };
  const pending = await db.insertEventDelivery({
    project_id: PROJECT, subscription_id: sub.id, event_type: "deployment.create",
    event_id: "evt-3", status: "pending", attempts: 0, next_attempt_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  });
  const retry = await attemptDelivery(db, failing, pending);
  assert.equal(retry.delivered, false);
  assert.equal(db.store.deliveries.get(pending.id).status, "pending");
  assert.ok(db.store.deliveries.get(pending.id).attempts >= 1);

  await deleteSubscription(db, ADMIN, { projectId: PROJECT, subscriptionId: sub.id });
  assert.equal(db.store.subs.size, 0);
  assert.ok(signEventBody("s", "{}").startsWith("t="));
});
