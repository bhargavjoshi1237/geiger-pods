/**
 * F7 (S15): `pg` devDependency + live-Postgres harness (`tests/helpers/pg.mjs`).
 *
 * - The harness lists every migration in version order and splits
 *   `@up`/`@down` (pure, always asserted).
 * - When `PODS_TEST_DB_URL` is set, `withMigrations` installs Supabase
 *   stubs, applies every `@up` in version order, runs the body, and rolls
 *   back — proven by asserting a catalog table exists inside and is gone
 *   after. When unset, it skips cleanly like the existing `[db]` tests.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMigrations,
  asUser,
  connectDb,
  dbUrl,
  migrationFiles,
  rollbackMigrations,
  splitMigration,
  withMigrations,
} from "../helpers/pg.mjs";

test("F7: harness lists every migration in version order with @up/@down", async () => {
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = join(process.cwd(), "supabase", "migrations");
  const expected = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".sql")) expected.push(full);
    }
  };
  walk(dir);
  const files = migrationFiles();
  assert.deepEqual([...files].sort(), [...expected].sort());
  assert.ok(files.length > 0);
  const versions = files.map((file) => file.split(/[/\\]/).pop().slice(0, 14));
  assert.deepEqual([...versions].sort(), versions, "migrations must be in version order");
  for (const file of files) {
    const { readFileSync } = await import("node:fs");
    const { up, down } = splitMigration(readFileSync(file, "utf8"));
    assert.ok(up.length > 0, `${file}: empty @up`);
    assert.ok(down.length > 0, `${file}: empty @down`);
  }
});

test("F7: splitMigration rejects files without @up/@down", () => {
  assert.throws(() => splitMigration("select 1;"), /@up.*@down/);
});

test("F7 [db]: withMigrations applies every @up, then rolls back", async (t) => {
  let ran = false;
  await withMigrations(t, async (client) => {
    ran = true;
    const { rows } = await client.query("SELECT to_regclass('pods.apis') AS oid;");
    assert.ok(rows[0].oid, "pods.apis must exist after @up");
    const { rows: roles } = await client.query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role');");
    assert.equal(roles.length, 3, "supabase role stubs must exist");
    const { rows: uid } = await client.query("SELECT auth.uid() AS uid;");
    assert.equal(uid[0].uid, null);
    await asUser(client, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const { rows: me } = await client.query("SELECT auth.uid() AS uid;");
    assert.equal(me[0].uid, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });
  if (!dbUrl()) {
    assert.equal(ran, false);
    return;
  }
  assert.equal(ran, true);
  // Fresh connection: the rollback dropped the catalog tables again.
  const client = await connectDb();
  try {
    const { rows } = await client.query("SELECT to_regclass('pods.apis') AS oid;");
    assert.equal(rows[0].oid, null, "pods.apis must be gone after @down rollback");
  } finally {
    await client.end();
  }
});

test("F7 [db]: apply/rollback round-trips without help", async (t) => {
  if (!dbUrl()) {
    t.skip("PODS_TEST_DB_URL is not set; database tests need a disposable Postgres.");
    return;
  }
  const client = await connectDb();
  try {
    await applyMigrations(client);
    const { rows } = await client.query("SELECT to_regclass('pods.deployments') AS oid;");
    assert.ok(rows[0].oid, "pods.deployments must exist after applyMigrations");
    await rollbackMigrations(client);
    const { rows: after } = await client.query("SELECT to_regclass('pods.deployments') AS oid;");
    assert.equal(after[0].oid, null);
  } finally {
    await client.end();
  }
});
