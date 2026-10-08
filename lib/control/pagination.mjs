/**
 * Shared cursor-pagination helpers (S15 F15).
 *
 * Every control-plane list endpoint uses cursor pagination per S01 §8:
 * `?limit=` (max 100, default 25) + `?cursor=`, returning
 * `{ items, nextCursor }`. The cursor is base64url JSON
 * `{ createdAt, id }` with a strict shape: ISO-8601 timestamp + UUID.
 * Strict validation here is the SSRF-style injection guard for the
 * PostgREST `or()` filters in `supabase-db.mjs` (F15): validated cursors
 * can never carry `,`, `(`, `)` or quote characters.
 *
 * Previously each service carried its own `encodeCursor`/`decodeCursor`
 * copy (`apis`, `connectors`, `integrations`, `secrets`, `audit`,
 * `authorizers`, `signing-credentials`). They now all delegate here.
 *
 * @module lib/control/pagination
 */

import { HttpError } from "./errors.mjs";

const ISO_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9]{2}:[0-9]{2})$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Encodes a list row into an opaque cursor.
 *
 * @param {{ created_at?: string, createdAt?: string, id: string }} row
 * @returns {string}
 */
export function encodeCursor(row) {
  const createdAt = row?.created_at ?? row?.createdAt ?? null;
  return Buffer.from(JSON.stringify({ createdAt, id: row?.id ?? null }), "utf8").toString("base64url");
}

/**
 * Decodes and strictly validates a cursor string.
 *
 * @param {unknown} cursor
 * @returns {{ createdAt: string, id: string }}
 * @throws {HttpError} 400 `invalid_input` when malformed.
 */
export function decodeCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (
      parsed
      && typeof parsed === "object"
      && typeof parsed.createdAt === "string"
      && ISO_PATTERN.test(parsed.createdAt)
      && typeof parsed.id === "string"
      && UUID_PATTERN.test(parsed.id)
    ) {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
  } catch {
    // Fall through to the 400 below.
  }
  throw new HttpError(400, "invalid_input", "Invalid pagination cursor.");
}

/**
 * Parses `?limit=` + `?cursor=` into a take + decoded cursor.
 *
 * @param {{ limit?: unknown, cursor?: unknown }} [input={}]
 * @returns {{ take: number, decoded: { createdAt: string, id: string } | null }}
 */
export function parsePaging({ limit, cursor } = {}) {
  const take = Math.min(Math.max(Number(limit) || 25, 1), 100);
  return { take, decoded: cursor ? decodeCursor(cursor) : null };
}

/**
 * Slices a limit+1 row window into `{ items, nextCursor }`.
 *
 * @template T,U
 * @param {Array<T>} rows - Up to `take + 1` rows.
 * @param {number} take
 * @param {(row: T) => U} map
 * @returns {{ items: Array<U>, nextCursor: string|null }}
 */
export function toPage(rows, take, map) {
  const items = (rows ?? []).slice(0, take).map(map);
  const nextCursor = (rows ?? []).length > take ? encodeCursor(rows[take - 1]) : null;
  return { items, nextCursor };
}
