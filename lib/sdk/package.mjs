/**
 * SDK file assembly + minimal stored-zip packaging (S13 part C).
 *
 * Dispatches to the native template generators (`javascript`, `typescript`,
 * `python`) or the OpenAPI Generator stubs (`java`, `android`, `swift`,
 * `ruby`, `go`, `kotlin`). Zips use a dependency-free stored (no
 * compression) writer so downloads need no new npm package.
 *
 * @module lib/sdk/package
 */

import { createHash } from "node:crypto";
import { checkSdkLanguage, cleanSdkConfig, EXTENDED_SDK_LANGUAGES } from "./languages.mjs";
import { generateJavascriptFiles } from "./javascript.mjs";
import { generateTypescriptFiles } from "./typescript.mjs";
import { generatePythonFiles } from "./python.mjs";
import { generateExtendedFiles } from "./extended.mjs";

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Builds the SDK file map for one stage export.
 *
 * @param {{ artifact: object, invokeUrl: string|null, docsByLocation?: Map<string, object>,
 *   language: string, config?: object }} input
 * @returns {Record<string, string>}
 */
export function buildSdkFiles({ artifact, invokeUrl, docsByLocation = new Map(), language, config = {} }) {
  void docsByLocation;
  const cleanLanguage = checkSdkLanguage(language);
  const clean = cleanSdkConfig(isObject(config) ? config : {});
  const base = { artifact: artifact ?? {}, invokeUrl: invokeUrl ?? null, config: clean };
  if (cleanLanguage === "javascript") return generateJavascriptFiles(base);
  if (cleanLanguage === "typescript") return generateTypescriptFiles(base);
  if (cleanLanguage === "python") return generatePythonFiles(base);
  if (EXTENDED_SDK_LANGUAGES.includes(cleanLanguage)) {
    return generateExtendedFiles({ ...base, language: cleanLanguage });
  }
  throw Object.assign(new Error(`Unsupported SDK language "${language}".`), { code: "invalid_language" });
}

/**
 * Stable hash of an SDK config (part of the job cache key).
 *
 * @param {object} [config={}]
 * @returns {string} Hex sha256 (16 chars).
 */
export function hashSdkConfig(config = {}) {
  return createHash("sha256").update(JSON.stringify(config ?? {}), "utf8").digest("hex").slice(0, 16);
}

function crc32Bytes(buffer) {
  let table = crc32Bytes.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    crc32Bytes.table = table;
  }
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.byteLength; index += 1) {
    crc = table[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Packs files as a stored (uncompressed) zip. Deterministic: fixed mtime,
 * sorted names, so the same file map always yields the same bytes.
 *
 * @param {Record<string, string>} files - Name → UTF-8 content.
 * @returns {Buffer}
 */
export function createSdkZip(files) {
  const names = Object.keys(files ?? {}).sort();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const name of names) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(files[name] ?? "", "utf8");
    const crc = crc32Bytes(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.byteLength, 18);
    header.writeUInt32LE(data.byteLength, 22);
    header.writeUInt16LE(nameBytes.byteLength, 26);
    header.writeUInt16LE(0, 28);
    chunks.push(header, nameBytes, data);
    central.push({ nameBytes, crc, size: data.byteLength, offset });
    offset += header.byteLength + nameBytes.byteLength + data.byteLength;
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const entry of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt32LE(entry.size, 28);
    header.writeUInt16LE(entry.nameBytes.byteLength, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt16LE(0, 38);
    header.writeUInt16LE(0, 40);
    header.writeUInt32LE(0, 42);
    header.writeUInt32LE(entry.offset, 42);
    chunks.push(header, entry.nameBytes);
    centralSize += header.byteLength + entry.nameBytes.byteLength;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  chunks.push(end);
  return Buffer.concat(chunks);
}

/**
 * Lists file names inside a stored zip made by `createSdkZip` (test helper;
 * parses local headers only, no decompression needed).
 *
 * @param {Buffer|Uint8Array} zip
 * @returns {Array<string>}
 */
export function listSdkZipNames(zip) {
  const buffer = Buffer.from(zip);
  const names = [];
  let offset = 0;
  while (offset + 30 <= buffer.byteLength) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const size = buffer.readUInt32LE(offset + 18);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    names.push(name);
    offset += 30 + nameLength + extraLength + size;
  }
  return names;
}
