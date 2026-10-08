/**
 * F14 (S15): catalog RLS tightening.
 *
 * - `apis_update` must not let `pods.api.update` holders soft-delete via
 *   direct SQL (a trigger requires `pods.api.delete` for `deleted_at`
 *   changes).
 * - `rest_resources` / `rest_methods` / `http_routes` write policies must
 *   not allow hard DELETE (INSERT + UPDATE only; service deletes are soft).
 *
 * Static contract asserts the migration text; the `[db]` test applies the
 * catalog migrations to a disposable Postgres and proves the behavior with
 * real RLS (skips cleanly when `PODS_TEST_DB_URL` is unset, like the S03
 * `[db]` test).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { asUser, withMigrations } from "../helpers/pg.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CATALOG_DIR = join(ROOT, "supabase", "migrations", "catalog");
const MIGRATION = join(CATALOG_DIR, "20261010000007_catalog_rls_tightening.sql");

function splitMigration(body) {
  const upIndex = body.indexOf("-- @up");
  const downIndex = body.indexOf("-- @down");
  assert.ok(upIndex !== -1 && downIndex !== -1 && downIndex > upIndex);
  return {
    up: body.slice(upIndex + "-- @up".length, downIndex).trim(),
    down: body.slice(downIndex + "-- @down".length).trim(),
  };
}

test("F14: migration contract — unique version, @up/@down, no FOR ALL, delete guard", () => {
  const names = readdirSync(CATALOG_DIR).filter((entry) => entry.endsWith(".sql")).sort();
  const versions = names.map((name) => name.slice(0, 14));
  assert.deepEqual([...new Set(versions)], versions, "catalog migration versions must be unique");
  assert.ok(names.includes("20261010000007_catalog_rls_tightening.sql"));

  const { up, down } = splitMigration(readFileSync(MIGRATION, "utf8"));
  // The three write policies become INSERT + UPDATE only.
  assert.ok(!/for\s+all/i.test(up), "@up must not contain any FOR ALL policy");
  for (const table of ["rest_resources", "rest_methods", "http_routes"]) {
    assert.match(up, new RegExp(`${table}_insert on pods\\.${table}\\s+for insert`, "is"));
    assert.match(up, new RegExp(`${table}_update on pods\\.${table}\\s+for update`, "is"));
  }
  // The apis soft-delete guard: a trigger on deleted_at requiring delete.
  assert.match(up, /apis_guard_delete/);
  assert.match(up, /pods\.api\.delete/);
  assert.match(up, /deleted_at/);
  // @down restores the FOR ALL policies and drops the guard.
  for (const table of ["rest_resources", "rest_methods", "http_routes"]) {
    assert.match(down, new RegExp(`${table}_write on pods\\.${table}\\s+for all`, "is"));
  }
  assert.match(down, /apis_guard_delete/);
});

async function connect(t) {
  if (!process.env.PODS_TEST_DB_URL) {
    t.skip("PODS_TEST_DB_URL is not set; database tests need a disposable Postgres.");
    return null;
  }
  let pg;
  try {
    pg = await import("pg");
  } catch {
    t.skip("PODS_TEST_DB_URL is set but no postgres driver is installed.");
    return null;
  }
  const client = new pg.Client({ connectionString: process.env.PODS_TEST_DB_URL });
  await client.connect();
  return client;
}

const USER_UPDATE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const USER_DELETE = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const USER_OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "f14f14f1-14f1-4f14-8f14-f14f14f14f14";

test("F14 [db]: update holders cannot soft-delete apis; route writers cannot hard-delete", async (t) => {
  // Proves the F7 harness serves real RLS tests: stubs + every @up applied.
  await withMigrations(t, async (client) => {
    await client.query(
      `insert into public.projects (id, organization_id, created_by) values ($1, 'org-f14', $2)
       on conflict (id) do update set organization_id = excluded.organization_id`,
      [PROJECT, USER_OWNER],
    );
    await client.query(
      `insert into public.organization_users (organization, "user", role) values
         ('org-f14', $1, 'Owner'), ('org-f14', $2, 'Member'), ('org-f14', $3, 'Member')
       on conflict do nothing`,
      [USER_OWNER, USER_UPDATE, USER_DELETE],
    );
    // Product roles: update-only and delete-capable.
    await client.query(
      `insert into public.roles (project_id, key, name, permissions)
       values ($1, 'api-editor', 'API Editor', '{pods.api.update}'),
              ($1, 'api-admin', 'API Admin', '{pods.api.update,pods.api.delete,pods.route.write}')
       on conflict do nothing`,
      [PROJECT],
    );
    await asUser(client, USER_OWNER);
    await client.query("select pods.grant_role($1, $2, 'api-editor', '{}')", [PROJECT, USER_UPDATE]);
    await client.query("select pods.grant_role($1, $2, 'api-admin', '{}')", [PROJECT, USER_DELETE]);
    const apiId = (await client.query(
      `insert into pods.apis (project_id, public_id, name, protocol) values ($1, 'f14f14f14f', 'F14', 'REST') returning id`,
      [PROJECT],
    )).rows[0].id;
    const rootId = (await client.query(
      `insert into pods.rest_resources (project_id, api_id, path_part) values ($1, $2, '') returning id`,
      [PROJECT, apiId],
    )).rows[0].id;
    const resourceId = (await client.query(
      `insert into pods.rest_resources (project_id, api_id, parent_id, path_part)
       values ($1, $2, $3, 'pets') returning id`,
      [PROJECT, apiId, rootId],
    )).rows[0].id;
    // A method and a route row so the hard-DELETE probes below match rows
    // (an unmatched DELETE returns 0 rows, not an RLS error).
    await client.query(
      `insert into pods.rest_methods (project_id, api_id, resource_id, http_method)
       values ($1, $2, $3, 'GET')`,
      [PROJECT, apiId, resourceId],
    );
    await client.query(
      `insert into pods.http_routes (project_id, api_id, route_key) values ($1, $2, 'GET /pets')`,
      [PROJECT, apiId],
    );

    // Update holder: renaming works, soft-deleting does not.
    await asUser(client, USER_UPDATE);
    await client.query("update pods.apis set name = 'F14-renamed' where id = $1", [apiId]);
    await assert.rejects(
      client.query("update pods.apis set deleted_at = now() where id = $1", [apiId]),
      /pods\.api\.delete|42501|permission denied|policy/i,
    );

    // Delete holder: soft-deleting works.
    await asUser(client, USER_DELETE);
    await client.query("update pods.apis set deleted_at = now() where id = $1", [apiId]);

    // Route writer (holds pods.route.write via api-admin): hard DELETE fails
    // on all three tables even though insert/update succeed.
    await assert.rejects(
      client.query("delete from pods.rest_resources where id = $1", [resourceId]),
      /row-level security|permission denied|policy/i,
    );
    await assert.rejects(
      client.query("delete from pods.rest_methods where resource_id = $1", [resourceId]),
      /row-level security|permission denied|policy/i,
    );
    await assert.rejects(
      client.query("delete from pods.http_routes where api_id = $1", [apiId]),
      /row-level security|permission denied|policy/i,
    );
    // And the service path (soft delete via UPDATE) still works.
    await client.query("update pods.rest_resources set deleted_at = now() where id = $1", [resourceId]);
  });
});
