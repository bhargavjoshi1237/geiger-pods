/**
 * F15 (S15 part 2): shared cursor-pagination module.
 *
 * All control-plane list services must delegate to
 * `lib/control/pagination.mjs` (no local `decodeCursor` copies), and the
 * shared decoder must strictly validate (ISO timestamp + UUID) so
 * PostgREST `or()` interpolation stays injection-safe. Authorizer-style
 * weak cursors (any string id) are rejected.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeCursor, encodeCursor, parsePaging, toPage } from "../../lib/control/pagination.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVICES = [
  "lib/control/apis.mjs",
  "lib/control/connectors.mjs",
  "lib/control/integrations.mjs",
  "lib/control/secrets.mjs",
  "lib/control/audit.mjs",
  "lib/control/authorizers.mjs",
  "lib/control/signing-credentials.mjs",
];

test("F15: cursor pagination lives in one module; services delegate to it", () => {
  for (const file of SERVICES) {
    const body = readFileSync(join(ROOT, file), "utf8");
    assert.match(body, /pagination\.mjs/, `${file} must import from pagination.mjs`);
    assert.ok(
      !/function decodeCursor\(/.test(body),
      `${file} must not carry its own decodeCursor copy`,
    );
    assert.ok(
      !/function decodeAuditCursor\(/.test(body),
      `${file} must not carry its own decodeAuditCursor copy`,
    );
  }
  // apis.mjs keeps the re-export seam for http-routes/rest-resources.
  const apis = readFileSync(join(ROOT, "lib/control/apis.mjs"), "utf8");
  assert.match(apis, /export \{[^}]*parsePaging[^}]*\}/, "apis.mjs must re-export parsePaging");
});

test("F15: shared decoder accepts strict cursors and rejects weak/forged ones", () => {
  const row = { created_at: "2026-10-07T12:00:00.000Z", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  const cursor = encodeCursor(row);
  assert.deepEqual(decodeCursor(cursor), { createdAt: row.created_at, id: row.id });
  // Weak authorizer-style cursor (non-UUID id) is rejected.
  const weak = Buffer.from(JSON.stringify({ createdAt: row.created_at, id: "not-a-uuid" }), "utf8").toString("base64url");
  assert.throws(() => decodeCursor(weak), /Invalid pagination cursor/);
  // Injection-shaped cursor is rejected (no PostgREST or() escape).
  const forged = Buffer.from(JSON.stringify({ createdAt: "2026-10-07T12:00:00.000Z),and(id.eq.1", id: row.id }), "utf8").toString("base64url");
  assert.throws(() => decodeCursor(forged), /Invalid pagination cursor/);
  assert.throws(() => decodeCursor("not-base64!!"), /Invalid pagination cursor/);
});

test("F15: parsePaging clamps limits and toPage slices windows", () => {
  assert.equal(parsePaging({ limit: 500 }).take, 100);
  assert.equal(parsePaging({ limit: 0 }).take, 25);
  assert.equal(parsePaging({}).decoded, null);
  const rows = [
    { created_at: "2026-10-07T12:00:00.000Z", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    { created_at: "2026-10-07T12:00:01.000Z", id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { created_at: "2026-10-07T12:00:02.000Z", id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
  ];
  const page = toPage(rows, 2, (row) => row.id);
  assert.deepEqual(page.items, [rows[0].id, rows[1].id]);
  assert.ok(typeof page.nextCursor === "string" && page.nextCursor.length > 0);
  const last = toPage(rows.slice(0, 2), 2, (row) => row.id);
  assert.equal(last.nextCursor, null);
});
