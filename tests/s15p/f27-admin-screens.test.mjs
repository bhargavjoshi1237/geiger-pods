/**
 * F27 (S15): admin screens (tokens, tags, stacks) are registered.
 *
 * - `settings/tokens` and `settings/stacks` resolve to the `tokens` /
 *   `stacks` screens (workspace screens list) and the registry mounts
 *   `TokensScreen` / `StacksPanel` (S14 standalone exports).
 * - Tags ship as the shared `TagsEditor` embedded in resource settings
 *   (no standalone screen by design — S14 defines tag APIs + an editor).
 * - The Settings screen links to the tokens/stacks sub-pages, which the
 *   catch-all project route (`/project/[id]/settings/tokens`) serves.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveScreen } from "../../lib/workspace/screens.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
async function source(relative) {
  return readFile(join(ROOT, relative), "utf8");
}

test("F27: settings/tokens and settings/stacks resolve to the admin screens", () => {
  assert.deepEqual(resolveScreen(["settings", "tokens"]), { section: "settings", screen: "tokens", params: {} });
  assert.deepEqual(resolveScreen(["settings", "stacks"]), { section: "settings", screen: "stacks", params: {} });
  assert.deepEqual(resolveScreen(["settings", "exports"]), { section: "monitoring", screen: "exports", params: {} });
  assert.deepEqual(resolveScreen(["monitoring", "exports"]), { section: "monitoring", screen: "exports", params: {} });
});

test("F27: registry mounts the admin screens", async () => {
  const registry = await source("components/internal/screens/registry.jsx");
  for (const name of ["TokensScreen", "StacksPanel"]) {
    assert.ok(registry.includes(name), `registry must import ${name}`);
  }
  for (const key of ["tokens:", "stacks:"]) {
    assert.ok(registry.includes(key), `registry must map screen ${key}`);
  }
  const barrel = await source("components/internal/screens/admin/index.js");
  for (const name of ["TokensScreen", "TagsEditor", "StacksPanel"]) {
    assert.ok(barrel.includes(name), `admin barrel must export ${name}`);
  }
});

test("F27: the sidebar Settings group links to the tokens/stacks sub-pages", async () => {
  const nav = await source("components/internal/sidebar/sidebar_nav.jsx");
  assert.ok(nav.includes('path: "settings/tokens"'), "sidebar must link to the tokens sub-page");
  assert.ok(nav.includes('path: "settings/stacks"'), "sidebar must link to the stacks sub-page");
  const page = await source("app/project/[projectId]/[[...rest]]/page.js");
  assert.ok(page.includes("resolveScreen"), "project catch-all route must serve workspace screens");
});

test("F27: TagsEditor is embedded in resource settings (no standalone screen)", async () => {
  const editor = await source("components/internal/screens/admin/tags_editor.jsx");
  assert.ok(editor.includes("TagsEditor"), "tags editor component must exist");
  const apiSettings = await source("components/internal/screens/apis/settings_tab.jsx");
  assert.ok(apiSettings.includes("TagsEditor"), "API settings must embed the tags editor");
});
