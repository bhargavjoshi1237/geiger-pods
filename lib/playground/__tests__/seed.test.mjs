// Seed integrity: the playground only convinces if its data hangs together.
// Run from the app root:
//   node --import ./lib/playground/__tests__/register.mjs --test lib/playground/__tests__/seed.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import { getPlaygroundDb } from "../db.js";
import { PLAYGROUND_PROJECT } from "../mode.js";

// EDIT PER APP: tables every seeded screen reads; each must have rows.
const REQUIRED_TABLES = [];

// EDIT PER APP: `<column>` -> table, for FK columns whose target isn't the
// plural of the column stem (owner_id -> profiles). `null` skips the column
// (it points outside the seed, e.g. an external provider id).
const FK_TARGETS = {
  // owner_id: "profiles",
  // stripe_customer_id: null,
};

// Tables whose rows legitimately belong to no project (lookups, users, ...).
const PROJECTLESS_OK = true;

function plural(word) {
  if (/[^aeiou]y$/.test(word)) return word.replace(/y$/, "ies");
  if (/(s|x|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

const db = getPlaygroundDb();
const tableNames = db.tableNames();

test("required tables are seeded", () => {
  for (const name of REQUIRED_TABLES) {
    assert.ok(db.table(name).length > 0, `${name} has no rows`);
  }
});

test("ids are unique per table", () => {
  for (const name of tableNames) {
    const ids = db.table(name).map((r) => r.id).filter((id) => id != null);
    assert.equal(new Set(ids).size, ids.length, `duplicate ids in ${name}`);
  }
});

test("foreign keys resolve inside the seed", () => {
  const problems = [];
  for (const name of tableNames) {
    for (const row of db.table(name)) {
      for (const [column, value] of Object.entries(row)) {
        if (!column.endsWith("_id") || value == null || column === "project_id") continue;
        const target = column in FK_TARGETS
          ? FK_TARGETS[column]
          : [plural(column.replace(/_id$/, "")), column.replace(/_id$/, "")].find((t) => db.has(t));
        if (!target) continue;
        if (!db.table(target).some((r) => String(r.id) === String(value))) {
          problems.push(`${name}.${column}=${value} -> ${target} (row ${row.id ?? "?"})`);
        }
      }
    }
  }
  assert.deepEqual(problems.slice(0, 20), [], `${problems.length} dangling references`);
});

test("project-owned rows belong to the playground project", () => {
  for (const name of tableNames) {
    for (const row of db.table(name)) {
      if (!("project_id" in row)) continue;
      if (row.project_id == null && PROJECTLESS_OK) continue;
      assert.equal(row.project_id, PLAYGROUND_PROJECT.id, `${name} row ${row.id} has project_id ${row.project_id}`);
    }
  }
});

test("timestamps parse", () => {
  for (const name of tableNames) {
    for (const row of db.table(name)) {
      for (const [column, value] of Object.entries(row)) {
        if (!column.endsWith("_at") || value == null) continue;
        assert.ok(!Number.isNaN(Date.parse(value)), `${name}.${column} is not a date: ${value}`);
      }
    }
  }
});
