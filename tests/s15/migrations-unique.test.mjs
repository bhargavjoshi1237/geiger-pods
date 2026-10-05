import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = join(ROOT, "supabase", "migrations");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".sql")) out.push(full);
  }
  return out;
}

test("S15: migration versions are unique", () => {
  const files = walk(DIR).sort();
  assert.ok(files.length > 0, "expected at least one migration");
  const seen = new Map();
  for (const file of files) {
    const base = file.split(/[/\\]/).pop();
    const match = base.match(/^(\d{14})_[a-zA-Z0-9_-]+\.sql$/);
    assert.ok(match, `bad migration filename ${base}`);
    const version = match[1];
    assert.ok(!seen.has(version), `Duplicate migration version ${version}: ${seen.get(version)} vs ${file}`);
    seen.set(version, file);
  }
});
