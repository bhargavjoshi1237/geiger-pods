/**
 * Per-frame accounting for WebSocket connections (S12 §2, S15 F37).
 *
 * AWS quotas: messages ≤ 128 KB **and** individual frames ≤ 32 KB, both
 * closing with 1009 when exceeded. The `ws` package's `maxPayload` only
 * caps the reassembled message, so single frames of 32–128 KB would pass
 * leniently. This module sniffs the inbound byte stream and reports any
 * data frame whose declared payload exceeds the frame budget, before `ws`
 * reassembles it.
 *
 * The sniffer only parses headers (FIN/opcode/length/mask) and skips
 * payload bytes, so it never unmasks or buffers message bodies. Control
 * frames are skipped (the peer stack enforces their ≤ 125 byte rule).
 * Partial headers split across TCP chunks are handled via an internal
 * buffer; multiple frames per chunk are consumed in a loop.
 *
 * @module lib/gateway/core/websocket/frames
 */

import { MAX_FRAME_BYTES } from "./constants.mjs";

/** Opcode classes we account (continuation, text, binary). */
function isDataOpcode(opcode) {
  return opcode === 0x0 || opcode === 0x1 || opcode === 0x2;
}

/**
 * Creates a streaming frame monitor for one inbound connection.
 *
 * @param {{ maxFrameBytes?: number, onViolation?: (info: { opcode: number, payloadLength: number }) => void }} [options={}]
 * @returns {{ feed(chunk: Uint8Array|Buffer): "ok"|"violation", violated: boolean, reset(): void }}
 */
export function createFrameMonitor({ maxFrameBytes = MAX_FRAME_BYTES, onViolation = null } = {}) {
  const limit = Number(maxFrameBytes) > 0 ? Number(maxFrameBytes) : MAX_FRAME_BYTES;
  let pending = Buffer.alloc(0);
  let skipRemaining = 0;
  let violated = false;

  function parseHeader(buffer) {
    if (buffer.length < 2) return null;
    const first = buffer[0];
    const second = buffer[1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < offset + 2) return null;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) return null;
      const big = buffer.readBigUInt64BE(offset);
      offset += 8;
      length = big > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER + 1 : Number(big);
    }
    if (masked) {
      if (buffer.length < offset + 4) return null;
      offset += 4;
    }
    return { opcode, headerLength: offset, payloadLength: length, masked, complete: true };
  }

  return {
    get violated() {
      return violated;
    },
    reset() {
      pending = Buffer.alloc(0);
      skipRemaining = 0;
      violated = false;
    },
    feed(chunk) {
      if (violated) return "violation";
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? []);
      if (bytes.length === 0) return "ok";
      pending = pending.length === 0 ? bytes : Buffer.concat([pending, bytes]);
      let cursor = 0;
      while (cursor < pending.length) {
        if (skipRemaining > 0) {
          const step = Math.min(skipRemaining, pending.length - cursor);
          skipRemaining -= step;
          cursor += step;
          continue;
        }
        const header = parseHeader(pending.subarray(cursor));
        if (!header) break;
        cursor += header.headerLength;
        if (isDataOpcode(header.opcode) && header.payloadLength > limit) {
          violated = true;
          pending = pending.subarray(cursor);
          try {
            onViolation?.({ opcode: header.opcode, payloadLength: header.payloadLength });
          } catch {
            // The violation stands even if the callback throws.
          }
          return "violation";
        }
        skipRemaining += header.payloadLength;
      }
      pending = cursor >= pending.length ? Buffer.alloc(0) : pending.subarray(cursor);
      // Bound the carry buffer: a header is at most 14 bytes, so anything
      // larger here is a logic error; reset rather than grow unboundedly.
      if (pending.length > 64) pending = Buffer.alloc(0);
      return "ok";
    },
  };
}

/**
 * Serializes a server→client close frame with the given code (unmasked).
 *
 * @param {number} [code=1009]
 * @param {string} [reason=""]
 * @returns {Buffer}
 */
export function closeFrame(code = 1009, reason = "") {
  const reasonBytes = Buffer.from(String(reason ?? ""), "utf8").slice(0, 123);
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  const header = Buffer.from([0x88, payload.length]);
  return Buffer.concat([header, payload]);
}
