import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import config from "../../geiger-rbac.config.js";
import { rolePermissionMap, rolePermissionsSql } from "../../scripts/gen-rbac-sql.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("S02: generated role_permissions SQL equals geiger-rbac config", () => {
  const map = rolePermissionMap(config);
  assert.deepEqual(Object.keys(map).sort(), ["admin", "manager", "member", "owner"]);
  for (const role of config.systemRoles) {
    assert.deepEqual(map[role.key], [...role.permissions], `role ${role.key} drifted from the config`);
  }
  assert.deepEqual(map.owner, ["*"]);

  const sql = rolePermissionsSql(config);
  assert.match(sql, /create or replace function pods\.role_permissions/);
  for (const role of config.systemRoles) {
    assert.ok(sql.includes(`when '${role.key}'`), `SQL is missing the ${role.key} branch`);
  }
  // Every non-wildcard pattern a role carries must be a catalogued key, and
  // every catalogued key held by a role must appear in the SQL.
  const known = new Set(config.permissions.map((permission) => permission.key));
  for (const role of config.systemRoles) {
    for (const pattern of role.permissions) {
      if (pattern === "*") continue;
      assert.ok(known.has(pattern), `role ${role.key} references unknown key ${pattern}`);
      assert.ok(sql.includes(`'${pattern}'`), `SQL is missing permission ${pattern}`);
    }
  }

  // The migration must embed exactly this generated body (drift protection).
  const migration = readFileSync(join(ROOT, "supabase", "migrations", "foundation", "20261006000102_authz_functions.sql"), "utf8");
  const start = migration.indexOf("-- GEN-RBAC-START");
  const end = migration.indexOf("-- GEN-RBAC-END");
  assert.ok(start !== -1 && end !== -1 && end > start, "migration is missing the generated block markers");
  const embedded = migration.slice(migration.indexOf("\n", start) + 1, end).trim();
  assert.equal(embedded, sql.trim(), "migration role_permissions body drifted from geiger-rbac.config.js");
});
