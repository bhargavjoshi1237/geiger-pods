/**
 * Live-Postgres harness for `[db]` tests (F7).
 *
 * `PODS_TEST_DB_URL` must point at a **disposable** database (empty schema;
 * CI provisions one per run). The harness:
 *
 * 1. installs Supabase-only prerequisites vanilla Postgres lacks (roles
 *    `anon`/`authenticated`/`service_role`, an `auth.uid()` reading
 *    `request.jwt.claims` like PostgREST does, minimal `public.projects` /
 *    `public.organization_users`, the `pgcrypto` extension),
 * 2. applies every migration's `@up` in version order,
 * 3. runs the test, then rolls everything back with `@down` in reverse.
 *
 * When `PODS_TEST_DB_URL` is unset (or `pg` is not installed) `withMigrations`
 * skips cleanly, exactly like the pre-existing `[db]` tests.
 *
 * Requires a Postgres role that can `CREATE ROLE` (role stubs) and install
 * `pgcrypto` (usually the database owner / a superuser). Without those the
 * harness throws a descriptive error instead of failing cryptically later.
 *
 * @module tests/helpers/pg
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HELPERS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HELPERS_DIR, "..", "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

/** Connection string for the disposable database, or null when unset. */
export function dbUrl() {
  return process.env.PODS_TEST_DB_URL ?? null;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".sql")) out.push(full);
  }
  return out;
}

function versionOf(file) {
  const base = file.split(/[/\\]/).pop();
  const match = base.match(/^(\d{14})_[a-zA-Z0-9_-]+\.sql$/);
  if (!match) throw new Error(`Bad migration filename ${base} (expected <14-digit-version>_<name>.sql).`);
  return match[1];
}

/**
 * Every migration file in version order (ties broken by path).
 *
 * @returns {Array<string>} Absolute paths.
 */
export function migrationFiles() {
  return walk(MIGRATIONS_DIR)
    .sort((a, b) => (versionOf(a) < versionOf(b) ? -1 : versionOf(a) > versionOf(b) ? 1 : a < b ? -1 : 1));
}

/**
 * Splits a migration into its `@up` / `@down` blocks.
 *
 * @param {string} body
 * @returns {{ up: string, down: string }}
 */
export function splitMigration(body) {
  const upIndex = body.indexOf("-- @up");
  const downIndex = body.indexOf("-- @down");
  if (upIndex === -1 || downIndex === -1 || downIndex <= upIndex) {
    throw new Error("Migration must contain -- @up followed by -- @down.");
  }
  return {
    up: body.slice(upIndex + "-- @up".length, downIndex).trim(),
    down: body.slice(downIndex + "-- @down".length).trim(),
  };
}

/**
 * Connects to the disposable database.
 *
 * @returns {Promise<import("pg").Client>}
 * @throws {{ code: "PODS_TEST_DB_SKIP" }} When `PODS_TEST_DB_URL` is unset.
 * @throws {{ code: "PODS_PG_DRIVER_MISSING" }} When `pg` is not installed.
 */
export async function connectDb() {
  if (!dbUrl()) {
    const error = new Error("PODS_TEST_DB_URL is not set; database tests need a disposable Postgres.");
    error.code = "PODS_TEST_DB_SKIP";
    throw error;
  }
  let pg;
  try {
    pg = await import("pg");
  } catch {
    const error = new Error("PODS_TEST_DB_URL is set but the \"pg\" devDependency is not installed.");
    error.code = "PODS_PG_DRIVER_MISSING";
    throw error;
  }
  const client = new pg.Client({ connectionString: dbUrl() });
  await client.connect();
  return client;
}

/**
 * Installs the Supabase-only prerequisites on vanilla Postgres. Safe to
 * run repeatedly (`IF NOT EXISTS` / `CREATE OR REPLACE` throughout).
 *
 * @param {import("pg").Client} client
 */
export async function ensureSupabaseStubs(client) {
  await client.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  END $$;`);
  await client.query("CREATE SCHEMA IF NOT EXISTS auth;");
  // `auth.uid()` mirrors PostgREST: the `sub` claim of `request.jwt.claims`.
  await client.query(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE plpgsql STABLE
    AS $$
    DECLARE
      claims text := current_setting('request.jwt.claims', true);
      sub text;
    BEGIN
      IF claims IS NULL OR claims = '' THEN RETURN NULL; END IF;
      BEGIN
        sub := (claims::jsonb ->> 'sub');
      EXCEPTION WHEN OTHERS THEN RETURN NULL;
      END;
      IF sub IS NULL OR sub = '' THEN RETURN NULL; END IF;
      BEGIN
        RETURN sub::uuid;
      EXCEPTION WHEN OTHERS THEN RETURN NULL;
      END;
    END;
    $$;`);
  // Minimal workspace tables the migrations reference but never create
  // (Supabase-managed in production).
  await client.query(`CREATE TABLE IF NOT EXISTS public.projects (
    id uuid PRIMARY KEY, organization_id text, created_by uuid
  );`);
  await client.query(`CREATE TABLE IF NOT EXISTS public.organization_users (
    organization text NOT NULL, "user" uuid NOT NULL, role text NOT NULL
  );`);
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
  } catch (error) {
    // Fall through to the capability check below for a clear message.
    void error;
  }
  const { rows } = await client.query("SELECT gen_random_uuid() AS id;");
  if (!rows?.[0]?.id) {
    throw new Error(
      "pgcrypto is unavailable (gen_random_uuid() failed). Run the [db] tests as a role that can " +
      "CREATE EXTENSION pgcrypto, or pre-install it on the disposable database.",
    );
  }
}

/**
 * Applies every migration's `@up` in version order (after stubs).
 *
 * @param {import("pg").Client} client
 * @param {Array<string>} [files=migrationFiles()]
 */
export async function applyMigrations(client, files = migrationFiles()) {
  await ensureSupabaseStubs(client);
  for (const file of files) {
    const { up } = splitMigration(readFileSync(file, "utf8"));
    if (up) await client.query(up);
  }
}

/**
 * Rolls back with every `@down` in reverse version order.
 *
 * @param {import("pg").Client} client
 * @param {Array<string>} [files=migrationFiles()]
 */
export async function rollbackMigrations(client, files = migrationFiles()) {
  for (const file of [...files].reverse()) {
    const { down } = splitMigration(readFileSync(file, "utf8"));
    if (down) await client.query(down);
  }
}

/**
 * Full lifecycle: connect → stubs → apply → `fn(client)` → rollback → end.
 * Skips cleanly via `t.skip` when no database (or no driver) is available.
 *
 * @param {import("node:test").TestContext} t
 * @param {(client: import("pg").Client) => Promise<void>} fn
 * @param {{ files?: Array<string> }} [options={}]
 */
export async function withMigrations(t, fn, { files = migrationFiles() } = {}) {
  let client = null;
  try {
    client = await connectDb();
  } catch (error) {
    if (error?.code === "PODS_TEST_DB_SKIP" || error?.code === "PODS_PG_DRIVER_MISSING") {
      t.skip(error.message);
      return;
    }
    throw error;
  }
  try {
    await applyMigrations(client, files);
    await fn(client);
  } finally {
    try {
      await rollbackMigrations(client, files);
    } finally {
      await client.end();
    }
  }
}

/**
 * Impersonates a Supabase `authenticated` user (what PostgREST sets per
 * request): `auth.uid()` returns `userId` until changed.
 *
 * @param {import("pg").Client} client
 * @param {string} userId - UUID string.
 */
export async function asUser(client, userId) {
  const claims = JSON.stringify({ sub: userId, role: "authenticated" });
  await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims]);
}
