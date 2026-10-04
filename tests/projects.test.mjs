import assert from "node:assert/strict";
import test from "node:test";

const { listAccessibleProjects } = await import("../lib/supabase/projects.js").catch(() => ({}));

function clientFixture(results) {
  return { schema: () => ({ from: (table) => {
    const query = { select: () => query, is: () => query, eq: () => query,
      order: () => query, then: (resolve, reject) => Promise.resolve(results[table]).then(resolve, reject) };
    return query;
  } }) };
}

test("project data is normalized and filtered by real membership", async () => {
  assert.equal(typeof listAccessibleProjects, "function");
  const client = clientFixture({ projects: { data: [
    { id: "yes", name: "Shared", organization_id: "org", created_by: "another" },
    { id: "no", organization_id: "other", created_by: "u" },
    { id: "mine", organization_id: null, created_by: "u" },
    { id: "unowned", organization_id: null, created_by: null },
  ] }, organization_users: { data: [{ organization: "org", user: "u", role: "Owner" }] } });
  const projects = await listAccessibleProjects(client, "u");
  assert.deepEqual(projects.map((p) => p.id), ["yes", "mine"]);
  assert.equal(projects[0].organizationId, "org");
  assert.equal(projects[0].inheritedRole, "owner");
});

test("database failures remain errors instead of becoming empty workspaces", async () => {
  assert.equal(typeof listAccessibleProjects, "function");
  const client = clientFixture({ projects: { data: [], error: { message: "project denied" } }, organization_users: { data: [] } });
  await assert.rejects(listAccessibleProjects(client, "u"), /project denied/);
  const membershipFailure = clientFixture({ projects: { data: [] }, organization_users: { error: { message: "membership denied" } } });
  await assert.rejects(listAccessibleProjects(membershipFailure, "u"), /membership denied/);
});
