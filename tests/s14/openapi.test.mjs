import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRoutes } from "../../scripts/gen-management-openapi.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Minimal YAML-paths reader: collects `  <path>:` lines under `paths:`
 * plus their indented method keys. Keeps the sync test dependency-free.
 */
function parseDocPaths(text) {
  const paths = new Map();
  const lines = text.split("\n");
  let inPaths = false;
  let current = null;
  for (const line of lines) {
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (!inPaths) continue;
    if (/^[a-zA-Z]/.test(line)) break;
    const pathMatch = line.match(/^  (\/[^:]*):\s*$/);
    if (pathMatch) {
      current = pathMatch[1];
      paths.set(current, new Set());
      continue;
    }
    const methodMatch = line.match(/^    (get|post|put|patch|delete|head|options):\s*$/);
    if (methodMatch && current) paths.get(current).add(methodMatch[1].toUpperCase());
  }
  return paths;
}

test("S14: every app/api/v1 route+method appears in pods-management.openapi.yaml and vice versa", async () => {
  const routes = await scanRoutes();
  assert.ok(routes.length > 50, `expected a full route tree, found ${routes.length}`);
  const text = await readFile(join(ROOT, "docs", "api", "pods-management.openapi.yaml"), "utf8");
  assert.match(text, /openapi: 3\.1/);
  const documented = parseDocPaths(text);
  const scannedPaths = new Set(routes.map((route) => route.path));
  for (const route of routes) {
    assert.ok(documented.has(route.path), `missing from openapi doc: ${route.path} (run node scripts/gen-management-openapi.mjs)`);
    for (const method of route.methods) {
      assert.ok(documented.get(route.path).has(method), `missing method ${method} ${route.path} in openapi doc`);
    }
  }
  for (const path of documented.keys()) {
    assert.ok(scannedPaths.has(path), `stale doc entry with no handler: ${path}`);
  }
  // S14's own routes are covered.
  for (const expected of ["/projects/{projectId}/access-tokens", "/projects/{projectId}/tags/{resourceType}/{resourceId}", "/projects/{projectId}/stacks/{stack}/{action}", "/projects/{projectId}/event-subscriptions"]) {
    assert.ok(documented.has(expected), `S14 route missing from doc: ${expected}`);
  }
});
