import assert from "node:assert/strict";
import test from "node:test";

import { getSettings, updateSettings } from "../../lib/control/settings.mjs";
import { HttpError } from "../../lib/control/errors.mjs";

const PROJECT = "22222222-2222-4222-8222-222222222222";

function fakeDb(roleByUser, row = null) {
  return {
    stored: row,
    async getInheritedRole({ userId }) {
      return roleByUser[userId] ?? null;
    },
    async listRoleBindings() {
      return { roles: [], grants: [] };
    },
    async getProjectSettings() {
      return this.stored;
    },
    async upsertProjectSettings(next) {
      this.stored = next;
      return next;
    },
    audits: [],
    async insertAudit(entry) {
      this.audits.push(entry);
    },
  };
}

const ADMIN = { type: "user", userId: "u-admin" };
const MEMBER = { type: "user", userId: "u-member" };

test("S02: settings read defaults for new projects and enforce write permission", async () => {
  const db = fakeDb({ "u-admin": "admin", "u-member": "member" });
  const viewed = await getSettings(db, MEMBER, { projectId: PROJECT });
  assert.equal(viewed.throttleRate, 10000);
  assert.equal(viewed.throttleKvFailure, "open");
  assert.equal(viewed.version, 0);

  await assert.rejects(
    updateSettings(db, MEMBER, { projectId: PROJECT, patch: { throttleRate: 5 } }),
    (error) => error instanceof HttpError && error.status === 403,
  );
  const updated = await updateSettings(db, ADMIN, {
    projectId: PROJECT,
    patch: { throttleRate: 500, throttleKvFailure: "closed" },
  });
  assert.equal(updated.throttleRate, 500);
  assert.equal(updated.throttleKvFailure, "closed");
  assert.equal(updated.version, 1);
  assert.equal(db.audits.length, 1);
  assert.equal(db.audits[0].action, "settings.update");
});

test("S02: settings writes validate input and conflict on stale versions", async () => {
  const db = fakeDb({ "u-admin": "admin" });
  await updateSettings(db, ADMIN, { projectId: PROJECT, patch: { logRetentionDays: 7 } });
  await assert.rejects(
    updateSettings(db, ADMIN, { projectId: PROJECT, patch: { throttleRate: -1 } }),
    (error) => error instanceof HttpError && error.status === 422,
  );
  await assert.rejects(
    updateSettings(db, ADMIN, { projectId: PROJECT, patch: { throttleRate: 9 }, expectedVersion: 0 }),
    (error) => error instanceof HttpError && error.status === 409 && error.code === "version_conflict",
  );
  const current = await getSettings(db, ADMIN, { projectId: PROJECT });
  const second = await updateSettings(db, ADMIN, {
    projectId: PROJECT,
    patch: { throttleRate: 9 },
    expectedVersion: current.version,
  });
  assert.equal(second.version, current.version + 1);
});
