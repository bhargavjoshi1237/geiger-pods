// Envelope encryption with node:crypto only (S02 §5).
//
// Per secret version: a random 32-byte DEK encrypts the value with AES-256-GCM;
// the DEK itself is wrapped (encrypted) with the KEK, also AES-256-GCM.
// AAD binds both envelopes to `${projectId}:${secretId}:${version}`, so a row
// copied to another secret or version fails authentication.
//
// Storage layout in `pods.secret_versions`:
//   ciphertext / iv / auth_tag          the value envelope
//   wrapped_dek                         wrapIv(12) || wrapTag(16) || wrappedDek(32)
//   kek_id                              which KEK wraps the DEK

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;

export class VaultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

/** Additional authenticated data binding a version to its secret. */
export function aadFor(projectId, secretId, version) {
  return `${projectId}:${secretId}:${version}`;
}

function encryptGcm(key, plaintext, aad) {
  if (key.length !== 32) throw new VaultError("INVALID_KEY", "AES-256-GCM needs a 32-byte key.");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), data };
}

function decryptGcm(key, envelope, aad) {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(envelope.tag);
    return Buffer.concat([decipher.update(envelope.data), decipher.final()]);
  } catch {
    throw new VaultError("DECRYPT_FAILED", "Authentication failed: tampered data, wrong AAD or wrong key.");
  }
}

function packWrapped({ iv, tag, data }) {
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || data.length !== DEK_BYTES) {
    throw new VaultError("INVALID_KEY", "Wrapped DEK envelope has an unexpected shape.");
  }
  return Buffer.concat([iv, tag, data]);
}

function unpackWrapped(wrapped) {
  const bytes = Buffer.from(wrapped);
  if (bytes.length !== IV_BYTES + TAG_BYTES + DEK_BYTES) {
    throw new VaultError("DECRYPT_FAILED", "Authentication failed: tampered data, wrong AAD or wrong key.");
  }
  return {
    iv: bytes.subarray(0, IV_BYTES),
    tag: bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES),
    data: bytes.subarray(IV_BYTES + TAG_BYTES),
  };
}

/**
 * Encrypt one secret version. Returns the `secret_versions` bytea columns.
 */
export function encryptSecretValue({ projectId, secretId, version, plaintext, kek, kekId }) {
  const aad = aadFor(projectId, secretId, version);
  const dek = randomBytes(DEK_BYTES);
  const value = encryptGcm(dek, Buffer.from(plaintext), aad);
  const wrapped = encryptGcm(kek, dek, aad);
  return {
    ciphertext: value.data,
    iv: value.iv,
    authTag: value.tag,
    wrappedDek: packWrapped(wrapped),
    kekId,
  };
}

/**
 * Decrypt one secret version. Throws VaultError(DECRYPT_FAILED) on tampered
 * ciphertext, wrong AAD or wrong KEK.
 */
export function decryptSecretValue({ projectId, secretId, version, kek, ciphertext, iv, authTag, wrappedDek }) {
  const aad = aadFor(projectId, secretId, version);
  const wrapped = unpackWrapped(wrappedDek);
  const dek = decryptGcm(kek, wrapped, aad);
  if (dek.length !== DEK_BYTES) throw new VaultError("DECRYPT_FAILED", "Authentication failed: wrong key.");
  return decryptGcm(dek, { iv: Buffer.from(iv), tag: Buffer.from(authTag), data: Buffer.from(ciphertext) }, aad);
}

/**
 * Re-wrap a DEK envelope under a new KEK without touching the ciphertext
 * (used by scripts/vault-rewrap.mjs during key rotation).
 */
export function rewrapDek({ projectId, secretId, version, wrappedDek, fromKek, toKek, toKid }) {
  const aad = aadFor(projectId, secretId, version);
  const dek = decryptGcm(fromKek, unpackWrapped(wrappedDek), aad);
  const wrapped = encryptGcm(toKek, dek, aad);
  return { wrappedDek: packWrapped(wrapped), kekId: toKid };
}
