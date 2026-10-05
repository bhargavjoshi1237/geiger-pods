/**
 * Request size limits (S01 defaults; S15 finalizes and enforces per-protocol).
 * Payload ceiling mirrors AWS: 10 MB.
 *
 * @module lib/gateway/core/limits
 */

/**
 * Default limits. `S15` owns enforcement and per-protocol tuning.
 * @type {{ maxBodyBytes: number, maxHeaderValueBytes: number, maxUrlLengthChars: number, maxHeaderCount: number }}
 */
export const LIMITS = {
  maxBodyBytes: 10 * 1024 * 1024,
  maxHeaderValueBytes: 10 * 1024,
  maxUrlLengthChars: 8192,
  maxHeaderCount: 100,
};

/**
 * Pure predicate: is this body byte length over the payload limit?
 *
 * @param {number} bytes
 * @param {{ maxBodyBytes?: number }} [limits=LIMITS]
 * @returns {boolean}
 */
export function exceedsBodyLimit(bytes, limits = LIMITS) {
  return bytes > (limits.maxBodyBytes ?? LIMITS.maxBodyBytes);
}

/**
 * Pure predicate: is this URL string over the URL length limit?
 * (S15 maps a violation to the 414 response; the S01 catalog has no
 * dedicated 414 type, so this stays a predicate until S15.)
 *
 * @param {string} url
 * @param {{ maxUrlLengthChars?: number }} [limits=LIMITS]
 * @returns {boolean}
 */
export function exceedsUrlLimit(url, limits = LIMITS) {
  return url.length > (limits.maxUrlLengthChars ?? LIMITS.maxUrlLengthChars);
}

/**
 * Pure predicate: are headers over the count/value-size limits?
 *
 * @param {Headers} headers
 * @param {{ maxHeaderValueBytes?: number, maxHeaderCount?: number }} [limits=LIMITS]
 * @returns {boolean}
 */
export function exceedsHeaderLimit(headers, limits = LIMITS) {
  const maxValue = limits.maxHeaderValueBytes ?? LIMITS.maxHeaderValueBytes;
  const maxCount = limits.maxHeaderCount ?? LIMITS.maxHeaderCount;
  const encoder = new TextEncoder();
  let count = 0;
  for (const [, value] of headers) {
    count += 1;
    if (encoder.encode(value).length > maxValue) return true;
  }
  return count > maxCount;
}
