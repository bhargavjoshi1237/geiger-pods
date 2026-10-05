// Re-wrap every secret DEK under a new KEK without touching ciphertext
// (S02 §5). Rotation procedure: add the new key to PODS_VAULT_KEYS, run with
// --to <new-kid>, verify, then promote PODS_VAULT_ACTIVE_KID.
//
// Usage: node scripts/vault-rewrap.mjs --to <kid> [--dry-run] [--limit N]
// Env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY.

import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { loadVaultKeys } from "../lib/vault/keys.mjs";
import { rewrapDek } from "../lib/vault/crypto.mjs";

function toBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string" && value.startsWith("\\x")) return Buffer.from(value.slice(2), "hex");
  return Buffer.from(value);
}

function toHexLiteral(bytes) {
  return `\\x${Buffer.from(bytes).toString("hex")}`;
}

/**
 * Pure planning step (unit-tested): which rows need re-wrapping and their new
 * envelopes. Skips rows already on `toKid`; throws when a key is missing.
 */
export function planRewrap(rows, { keys, toKid }) {
  if (!keys.keys[toKid]) throw new Error(`Target vault key "${toKid}" is not configured.`);
  const plan = [];
  for (const row of rows) {
    if (row.kek_id === toKid) continue;
    const fromKek = keys.keys[row.kek_id];
    if (!fromKek) throw new Error(`Row ${row.id} is wrapped with unknown vault key "${row.kek_id}".`);
    const rewrapped = rewrapDek({
      projectId: row.project_id,
      secretId: row.secret_id,
      version: row.version,
      wrappedDek: toBytes(row.wrapped_dek),
      fromKek,
      toKek: keys.keys[toKid],
      toKid,
    });
    plan.push({ id: row.id, wrappedDek: rewrapped.wrappedDek, kekId: rewrapped.kekId });
  }
  return plan;
}

function parseArgs(argv) {
  const args = { to: null, dryRun: false, limit: 500 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--to") args.to = argv[index + 1];
    if (argv[index] === "--dry-run") args.dryRun = true;
    if (argv[index] === "--limit") args.limit = Number(argv[index + 1]);
  }
  if (!args.to) throw new Error("Pass --to <kid> with the target vault key id.");
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error("--limit must be a positive integer.");
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const keys = loadVaultKeys();
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

  let rewrapped = 0;
  let skipped = 0;
  for (;;) {
    const { data, error } = await supabase.schema("pods")
      .from("secret_versions")
      .select("id, secret_id, version, wrapped_dek, kek_id, secrets!inner(project_id)")
      .neq("kek_id", args.to)
      .limit(args.limit);
    if (error) throw error;
    if (!data || data.length === 0) break;
    const rows = data.map((row) => ({ ...row, project_id: row.secrets.project_id }));
    const plan = planRewrap(rows, { keys, toKid: args.to });
    skipped += rows.length - plan.length;
    if (args.dryRun) {
      rewrapped += plan.length;
      if (data.length < args.limit) break;
      continue;
    }
    for (const entry of plan) {
      const { error: updateError } = await supabase.schema("pods")
        .from("secret_versions")
        .update({ wrapped_dek: toHexLiteral(entry.wrappedDek), kek_id: entry.kekId })
        .eq("id", entry.id);
      if (updateError) throw updateError;
      rewrapped += 1;
    }
    if (data.length < args.limit) break;
  }
  process.stdout.write(`vault-rewrap: rewrapped ${rewrapped}, skipped ${skipped} (already on target).\n`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`vault-rewrap failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
