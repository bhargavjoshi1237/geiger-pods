import assert from "node:assert/strict";
import test from "node:test";
import { subscribeToSession } from "../lib/supabase/session.js";

function authFixture() {
  let listener;
  let unsubscribed = false;
  const auth = {
    onAuthStateChange(callback) {
      listener = callback;
      return { data: { subscription: { unsubscribe() { unsubscribed = true; } } } };
    },
    getSession: async () => ({ data: { session: null }, error: null }),
    getUser() { throw new Error("Session inheritance must not require another user lookup"); },
  };
  return { client: { auth }, emit: (event, session) => listener(event, session), isUnsubscribed: () => unsubscribed };
}

test("recognizes the inherited INITIAL_SESSION without another user lookup", () => {
  const fixture = authFixture();
  const states = [];
  const subscription = subscribeToSession(fixture.client, (state) => states.push(state));
  const user = { id: "parent-user" };
  fixture.emit("INITIAL_SESSION", { user });
  assert.deepEqual(states.at(-1), { status: "authenticated", user, error: null });
  subscription.unsubscribe();
});

test("rechecks cookies after sign-in in the parent on another localhost port", async () => {
  const fixture = authFixture();
  const states = [];
  const subscription = subscribeToSession(fixture.client, (state) => states.push(state));
  fixture.emit("INITIAL_SESSION", null);
  const user = { id: "parent-user" };
  fixture.client.auth.getSession = async () => ({ data: { session: { user } }, error: null });
  await subscription.refresh();
  assert.deepEqual(states.at(-1), { status: "authenticated", user, error: null });
  fixture.client.auth.getSession = async () => ({ data: { session: null }, error: null });
  await subscription.refresh();
  assert.deepEqual(states.at(-1), { status: "signed-out", user: null, error: null });
  subscription.unsubscribe();
});

test("token refresh keeps the inherited user available", () => {
  const fixture = authFixture();
  const states = [];
  const subscription = subscribeToSession(fixture.client, (state) => states.push(state));
  const user = { id: "parent-user" };
  fixture.emit("TOKEN_REFRESHED", { user });
  assert.equal(states.at(-1).status, "authenticated");
  assert.equal(states.at(-1).user, user);
  subscription.unsubscribe();
});

test("a pending cookie check cannot restore a user after sign-out", async () => {
  const fixture = authFixture();
  const states = [];
  const subscription = subscribeToSession(fixture.client, (state) => states.push(state));
  let resolve;
  fixture.client.auth.getSession = () => new Promise((done) => { resolve = done; });
  const pending = subscription.refresh();
  fixture.emit("SIGNED_OUT", null);
  resolve({ data: { session: { user: { id: "old-user" } } }, error: null });
  await pending;
  assert.deepEqual(states.at(-1), { status: "signed-out", user: null, error: null });
  subscription.unsubscribe();
});

test("session errors clear identity and remain retryable", async () => {
  const fixture = authFixture();
  const states = [];
  const subscription = subscribeToSession(fixture.client, (state) => states.push(state));
  fixture.client.auth.getSession = async () => ({ data: { session: null }, error: new Error("Refresh failed") });
  await subscription.refresh();
  assert.deepEqual(states.at(-1), { status: "error", user: null, error: "Refresh failed" });
  fixture.client.auth.getSession = async () => ({ data: { session: { user: { id: "new-user" } } }, error: null });
  await subscription.refresh();
  assert.equal(states.at(-1).user.id, "new-user");
  subscription.unsubscribe();
});

test("unsubscribing prevents pending checks from updating an unmounted provider", async () => {
  const fixture = authFixture();
  const states = [];
  const subscription = subscribeToSession(fixture.client, (state) => states.push(state));
  let resolve;
  fixture.client.auth.getSession = () => new Promise((done) => { resolve = done; });
  const pending = subscription.refresh();
  subscription.unsubscribe();
  resolve({ data: { session: { user: { id: "old-user" } } }, error: null });
  await pending;
  assert.equal(states.length, 0);
  assert.equal(fixture.isUnsubscribed(), true);
});
