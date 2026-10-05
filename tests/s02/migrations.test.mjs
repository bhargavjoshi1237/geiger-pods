import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "supabase", "migrations", "foundation");
const files = readdirSync(DIR).filter((name) => name.endsWith(".sql")).sort();

test("S02: foundation migrations follow the geiger-orm file contract", () => {
  assert.ok(files.length >= 5, `expected at least 5 foundation migrations, saw ${files.length}`);
  let previous = "";
  for (const name of files) {
    assert.match(name, /^\d{14}_[a-z0-9_]+\.sql$/, `bad migration filename ${name}`);
    const stamp = name.slice(0, 14);
    assert.ok(stamp > previous, `migration ${name} is out of timestamp order`);
    previous = stamp;
    const body = readFileSync(join(DIR, name), "utf8");
    assert.ok(body.includes("-- @up"), `${name} is missing -- @up`);
    assert.ok(body.includes("-- @down"), `${name} is missing -- @down (rollback must exist)`);
    assert.ok(!/using\s*\(\s*true\s*\)/i.test(body), `${name} still contains a demo using (true) policy`);
  }
});

test("S02: foundation migrations gate tables and keep ciphertext out of reach", () => {
  const all = files.map((name) => readFileSync(join(DIR, name), "utf8")).join("\n");
  assert.ok(all.includes("pods.role_permissions"), "role_permissions generator output is missing");
  assert.ok(all.includes("pods.grant_role"), "grant_role writer is missing");
  assert.ok(all.includes("audit_events is append-only"), "audit append-only trigger is missing");
  assert.ok(all.includes("revoke select"), "column-level ciphertext revoke is missing");
  assert.ok(all.includes("pods.secret.write"), "secret write policy is missing");
  assert.ok(all.includes("pods.audit.view"), "audit view policy is missing");
  // No example credentials or private keys may ship in a migration.
  assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(all), "a private key shipped in a migration");
});
