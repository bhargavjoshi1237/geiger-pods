/**
 * Identifier factories for the gateway (ADR-5).
 *
 * - DB primary keys are `uuid` (`gen_random_uuid()`), created in Postgres.
 * - Public API ids are 10 chars `[a-z0-9]`, used in hostnames.
 * - Other public short ids are 6–10 chars `[a-z0-9]`, unique per API/project.
 * - Request ids are UUID v4; extended request ids are base32 timestamp+random.
 *
 * @module lib/gateway/ids
 */

import { randomUUID } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ALPHABET_SIZE = ALPHABET.length;
/** Largest byte value that maps without bias: 36 * 7 = 252. */
const REJECTION_LIMIT = Math.floor(256 / ALPHABET_SIZE) * ALPHABET_SIZE;

function randomBytes(n) {
  const buf = new Uint8Array(n);
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

/**
 * Returns a random `[a-z0-9]` string of `length` chars using
 * `crypto.getRandomValues` with rejection sampling (no modulo bias).
 *
 * @param {number} length - Desired length (6–10 for short ids).
 * @returns {string}
 */
export function newShortId(length) {
  if (!Number.isInteger(length) || length <= 0) {
    throw new TypeError("newShortId(length) requires a positive integer");
  }
  let out = "";
  while (out.length < length) {
    const bytes = randomBytes(length - out.length);
    for (const b of bytes) {
      if (b >= REJECTION_LIMIT) continue;
      out += ALPHABET[b % ALPHABET_SIZE];
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * Returns a 10-char lowercase-alnum public id (like AWS `a1b2c3d4e5`),
 * immutable and used in hostnames.
 *
 * @returns {string}
 */
export function newPublicId() {
  return newShortId(10);
}

/**
 * Returns a UUID v4 request id.
 *
 * @returns {string}
 */
export function newRequestId() {
  return randomUUID();
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * Encodes bytes as unpadded base32 (RFC 4648 alphabet, lowercase).
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function base32Encode(bytes) {
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(acc >>> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32[(acc << (5 - bits)) & 31];
  return out;
}

/**
 * Returns an extended request id: base32 timestamp + random,
 * in the spirit of AWS `extendedRequestId`.
 *
 * @param {number} [nowMs=Date.now()] - Millisecond timestamp prefix.
 * @returns {string}
 */
export function newExtendedRequestId(nowMs = Date.now()) {
  const time = new Uint8Array(6);
  let t = Math.floor(nowMs);
  for (let i = 5; i >= 0; i--) {
    time[i] = t & 0xff;
    t = Math.floor(t / 256);
  }
  const rand = randomBytes(10);
  const bytes = new Uint8Array(16);
  bytes.set(time, 0);
  bytes.set(rand, 6);
  return base32Encode(bytes);
}
