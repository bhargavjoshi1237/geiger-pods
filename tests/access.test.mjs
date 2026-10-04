import assert from "node:assert/strict";
import test from "node:test";
import { can } from "@geiger/rbac";

const access = await import("../lib/workspace/access.mjs").catch(() => ({}));
const { default: config } = await import("../geiger-rbac.config.js").catch(() => ({}));

test("an org project requires membership even for its creator", () => {
  assert.equal(typeof access.inheritedRole, "function");
  const project = { organizationId: "org", createdBy: "u" };
  assert.equal(access.inheritedRole(project, [], "u"), null);
  assert.equal(access.inheritedRole(project, [{ organizationId: "other", userId: "u", role: "Owner" }], "u"), null);
  assert.equal(access.inheritedRole(project, [{ organizationId: "org", userId: "other", role: "Owner" }], "u"), null);
});

test("suite roles map from trusted membership rows", () => {
  assert.equal(typeof access.inheritedRole, "function");
  const project = { organizationId: "org" };
  for (const [suite, expected] of [["Owner", "owner"], ["ADMIN", "admin"], ["Manager", "manager"], ["User", "member"]]) {
    assert.equal(access.inheritedRole(project, [{ organizationId: "org", userId: "u", role: suite }], "u"), expected);
  }
});

test("only the authenticated creator can enter an org-less project", () => {
  assert.equal(typeof access.inheritedRole, "function");
  const project = { organizationId: null, createdBy: "u" };
  assert.equal(access.inheritedRole(project, [], "u"), "owner");
  assert.equal(access.inheritedRole(project, [], "other"), null);
  assert.equal(access.inheritedRole({ organizationId: null, createdBy: null }, [], null), null);
});

test("every inherited role is read-only and missing identity fails closed", () => {
  assert.equal(typeof access.inheritedAuthorization, "function");
  for (const role of ["owner", "admin", "manager", "member"]) {
    const binding = access.inheritedAuthorization(role, "u", "project");
    const options = { config, ...binding, actorId: "u" };
    assert.equal(can("pods.overview.view", options), true);
    assert.equal(can("pods.settings.view", options), true);
    assert.equal(can("pods.api.create", options), false);
    assert.equal(can("pods.deployment.publish", options), false);
  }
  const options = { config, ...access.inheritedAuthorization(null, null, null) };
  assert.equal(can("pods.overview.view", options), false);
});
