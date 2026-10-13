// Shared seeding context: env, the service-role Supabase client, the control
// db composed exactly like the management API routes compose it, the acting
// user, and small find-or-create helpers so the seed can be re-run after a
// partial failure without duplicating rows.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { createControlDb } from "../../lib/control/supabase-db.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Geiger Notes (projects.id) and the account the showcase is seeded as. */
export const PROJECT_ID = "ebcc7910-1a0e-4e91-8c3b-752f3c4292d3";
export const OWNER_ID = "39149c4b-526f-445b-8a8c-ea3898e9c50c"; // bhargavjoshi1237@gmail.com

/** Loads `.env` into process.env (without overriding values already set). */
export function loadEnv() {
  const text = readFileSync(join(ROOT, ".env"), "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "PODS_VAULT_KEYS", "PODS_VAULT_ACTIVE_KID", "PODS_KEY_PEPPER"]) {
    if (!process.env[key]) throw new Error(`${key} is not set in .env`);
  }
}

export function createSeedContext() {
  loadEnv();
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  // The service-role client plays both roles: RLS is bypassed, and every
  // service still runs its own requirePermission check against the owner.
  const db = createControlDb(supabase, { service: supabase });
  // `acquire_deploy_lock` authorizes auth.uid(), which a service-role client
  // has none of; undefined makes createDeployment use its in-process lock.
  db.advisoryLock = async () => undefined;
  const actor = { type: "user", userId: OWNER_ID };
  return { supabase, db, actor, projectId: PROJECT_ID, log: createLog() };
}

function createLog() {
  let section = "";
  return {
    section(name) {
      section = name;
      console.log(`\n== ${name}`);
    },
    item(message) {
      console.log(`   ${message}`);
    },
    skip(message) {
      console.log(`   · ${message} (exists)`);
    },
    get current() {
      return section;
    },
  };
}

/** Service results are `{ status, body }` or a bare view; returns the view. */
export function body(result) {
  if (result && typeof result === "object" && "body" in result && "status" in result) {
    return result.body;
  }
  return result;
}

/** Items from a list result (`{ items }`, a bare array, or `{ body: { items } }`). */
export function items(result) {
  const value = body(result);
  if (Array.isArray(value)) return value;
  return value?.items ?? [];
}

/** Find-or-create by a predicate over an existing list. */
export async function ensure(log, label, { find, create }) {
  const existing = await find();
  if (existing) {
    log.skip(label);
    return existing;
  }
  const created = body(await create());
  log.item(`+ ${label}`);
  return created;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
