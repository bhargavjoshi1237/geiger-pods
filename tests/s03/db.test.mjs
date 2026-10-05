import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Live-Postgres test (S01 §9): runs only when PODS_TEST_DB_URL points at a
// disposable database. Applies the foundation + catalog migrations and
// verifies catalog RLS with an owner, a manager, a member and a scoped
// grantee, then rolls everything back.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "supabase", "migrations");

function splitMigration(body) {
  const upIndex = body.indexOf("-- @up");
  const downIndex = body.indexOf("-- @down");
  assert.ok(upIndex !== -1 && downIndex !== -1 && downIndex > upIndex);
  return {
    up: body.slice(upIndex + "-- @up".length, downIndex).trim(),
    down: body.slice(downIndex + "-- @down".length).trim(),
  };
}

function migrationFiles() {
  const out = [];
  for (const dir of ["foundation", "catalog"]) {
    const full = join(ROOT, dir);
    for (const name of readdirSync(full).filter((entry) => entry.endsWith(".sql")).sort()) {
      out.push(join(full, name));
    }
  }
  return out;
}

async function connect(t) {
  if (!process.env.PODS_TEST_DB_URL) {
    t.skip("PODS_TEST_DB_URL is not set; database tests need a disposable Postgres.");
    return null;
  }
  let pg;
  try {
    pg = await import("pg");
  } catch {
    t.skip("PODS_TEST_DB_URL is set but no postgres driver is installed (add \"pg\" to run live database tests).");
    return null;
  }
  const client = new pg.Client({ connectionString: process.env.PODS_TEST_DB_URL });
  await client.connect();
  return client;
}

function asUser(client, userId) {
  const claims = JSON.stringify({ sub: userId, role: "authenticated" });
  return client.query("select set_config('request.jwt.claims', $1, true)", [claims]);
}

const USER_OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_MANAGER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_MEMBER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const USER_SCOPED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PROJECT = "p0p0p0p0-p0p0-4a1a-8a1a-a1a1a1a1a1a1";

async function withMigrations(t, fn) {
  const client = await connect(t);
  if (!client) return;
  const files = migrationFiles();
  try {
    for (const name of files) {
      await client.query(splitMigration(readFileSync(name, "utf8")).up);
    }
    await fn(client);
  } finally {
    for (const name of [...files].reverse()) {
      await client.query(splitMigration(readFileSync(name, "utf8")).down);
    }
    await client.end();
  }
}

test("S03 [db]: manager can create routes; member cannot; grant scoped to API A cannot edit API B routes", async (t) => {
  await withMigrations(t, async (client) => {
    await client.query(
      `insert into public.projects (id, organization_id, created_by) values ($1, 'org-s03', $2)
       on conflict (id) do update set organization_id = excluded.organization_id`,
      [PROJECT, USER_OWNER],
    );
    await client.query(
      `insert into public.organization_users (organization, "user", role) values
         ('org-s03', $1, 'Owner'), ('org-s03', $2, 'Manager'),
         ('org-s03', $3, 'Member'), ('org-s03', $4, 'Member')
       on conflict do nothing`,
      [USER_OWNER, USER_MANAGER, USER_MEMBER, USER_SCOPED],
    );

    // Owner seeds two APIs.
    await asUser(client, USER_OWNER);
    const apiA = (await client.query(
      `insert into pods.apis (project_id, public_id, name, protocol) values ($1, 'aaaaaaaaaa', 'A', 'HTTP') returning id`,
      [PROJECT],
    )).rows[0].id;
    const apiB = (await client.query(
      `insert into pods.apis (project_id, public_id, name, protocol) values ($1, 'bbbbbbbbbb', 'B', 'HTTP') returning id`,
      [PROJECT],
    )).rows[0].id;

    // Manager can create routes (unscoped build grant from the system role).
    await asUser(client, USER_MANAGER);
    await client.query(
      "insert into pods.http_routes (project_id, api_id, route_key) values ($1, $2, 'GET /m')",
      [PROJECT, apiA],
    );

    // Member cannot.
    await asUser(client, USER_MEMBER);
    await assert.rejects(
      client.query("insert into pods.http_routes (project_id, api_id, route_key) values ($1, $2, 'GET /no')", [PROJECT, apiA]),
      /row-level security|permission denied|policy/i,
    );

    // Scoped grant: route.write narrowed to API A.
    await asUser(client, USER_OWNER);
    await client.query(
      `insert into public.roles (project_id, key, name, permissions)
       values ($1, 'api-dev', 'API Dev', '{pods.route.write}')
       on conflict do nothing`,
      [PROJECT],
    );
    await client.query("select pods.grant_role($1, $2, 'api-dev', $3)", [
      PROJECT,
      USER_SCOPED,
      JSON.stringify({ api: [apiA] }),
    ]);

    await asUser(client, USER_SCOPED);
    await client.query(
      "insert into pods.http_routes (project_id, api_id, route_key) values ($1, $2, 'GET /scoped-a')",
      [PROJECT, apiA],
    );
    await assert.rejects(
      client.query("insert into pods.http_routes (project_id, api_id, route_key) values ($1, $2, 'GET /scoped-b')", [PROJECT, apiB]),
      /row-level security|permission denied|policy/i,
    );
  });
});
