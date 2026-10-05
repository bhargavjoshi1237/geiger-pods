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

test("inherited roles follow the S02 permission matrix and missing identity fails closed", () => {
  assert.equal(typeof access.inheritedAuthorization, "function");
  const optionsFor = (role) => ({ config, ...access.inheritedAuthorization(role, "u", "project"), actorId: "u" });
  for (const role of ["owner", "admin", "manager", "member"]) {
    const options = optionsFor(role);
    assert.equal(can("pods.overview.view", options), true);
    assert.equal(can("pods.settings.view", options), true);
    assert.equal(can("pods.nope.missing", options), false);
  }
  assert.equal(can("pods.api.create", optionsFor("owner")), true);
  assert.equal(can("pods.role.grant", optionsFor("owner")), true);
  assert.equal(can("pods.secret.write", optionsFor("admin")), true);
  assert.equal(can("pods.role.grant", optionsFor("admin")), false);
  assert.equal(can("pods.route.write", optionsFor("manager")), true);
  assert.equal(can("pods.stage.delete", optionsFor("manager")), false);
  assert.equal(can("pods.secret.write", optionsFor("manager")), false);
  assert.equal(can("pods.secret.use", optionsFor("manager")), true);
  assert.equal(can("pods.api.create", optionsFor("member")), false);
  assert.equal(can("pods.secret.use", optionsFor("member")), false);
  const options = { config, ...access.inheritedAuthorization(null, null, null) };
  assert.equal(can("pods.overview.view", options), false);
});
