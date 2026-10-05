import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Live-Postgres tests (S01 §9): run only when PODS_TEST_DB_URL points at a
// disposable database. They apply the foundation migrations and verify RLS
// with two users and two projects, then roll everything back.

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "supabase", "migrations", "foundation");

function splitMigration(body) {
  const upIndex = body.indexOf("-- @up");
  const downIndex = body.indexOf("-- @down");
  assert.ok(upIndex !== -1 && downIndex !== -1 && downIndex > upIndex);
  return {
    up: body.slice(upIndex + "-- @up".length, downIndex).trim(),
    down: body.slice(downIndex + "-- @down".length).trim(),
  };
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

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const PROJECT_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";

async function withMigrations(t, fn) {
  const client = await connect(t);
  if (!client) return;
  const files = readdirSync(DIR).filter((name) => name.endsWith(".sql")).sort();
  try {
    for (const name of files) {
      await client.query(splitMigration(readFileSync(join(DIR, name), "utf8")).up);
    }
    await fn(client);
  } finally {
    for (const name of [...files].reverse()) {
      await client.query(splitMigration(readFileSync(join(DIR, name), "utf8")).down);
    }
    await client.end();
  }
}

test("S02 [db]: user A cannot select rows of project B; nonmember of org project sees nothing even if public.projects RLS is permissive", async (t) => {
  await withMigrations(t, async (client) => {
    await client.query(
      `insert into public.projects (id, organization_id, created_by) values
         ($1, 'org-a', $2), ($3, 'org-a', $2)
       on conflict (id) do update set organization_id = excluded.organization_id`,
      [PROJECT_A, USER_A, PROJECT_B],
    );
    await client.query(
      `insert into public.organization_users (organization, "user", role) values ('org-a', $1, 'Owner')
       on conflict do nothing`,
      [USER_A],
    );
    await client.query(
      `insert into pods.project_settings (project_id, throttle_rate) values ($1, 111), ($2, 222)
       on conflict (project_id) do update set throttle_rate = excluded.throttle_rate`,
      [PROJECT_A, PROJECT_B],
    );

    await asUser(client, USER_A);
    const own = await client.query("select project_id from pods.project_settings");
    assert.deepEqual(own.rows.map((row) => row.project_id).sort(), [PROJECT_A]);

    await asUser(client, USER_B);
    const foreign = await client.query("select project_id from pods.project_settings");
    assert.deepEqual(foreign.rows, []);
  });
});

test("S02 [db]: authenticated role cannot select secret_versions.ciphertext", async (t) => {
  await withMigrations(t, async (client) => {
    await asUser(client, USER_A);
    await assert.rejects(
      client.query("select ciphertext from pods.secret_versions limit 1"),
      /permission denied|column|revoke/i,
    );
  });
});

test("S02 [db]: audit_events rejects update and delete", async (t) => {
  await withMigrations(t, async (client) => {
    await client.query(
      `insert into public.projects (id, organization_id, created_by) values ($1, null, $2)
       on conflict (id) do update set created_by = excluded.created_by`,
      [PROJECT_A, USER_A],
    );
    const inserted = await client.query(
      `insert into pods.audit_events (project_id, actor_id, actor_type, action, resource_type)
       values ($1, $2, 'user', 'test.ping', 'secret') returning id`,
      [PROJECT_A, USER_A],
    );
    const id = inserted.rows[0].id;
    await assert.rejects(client.query("update pods.audit_events set action = 'x' where id = $1", [id]), /append-only/);
    await assert.rejects(client.query("delete from pods.audit_events where id = $1", [id]), /append-only/);
  });
});
