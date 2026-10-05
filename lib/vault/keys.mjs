// Vault key loading (S02 §5). Keys live only in server env:
//   PODS_VAULT_KEYS      JSON map { "<kid>": "<base64 32 bytes>" }
//   PODS_VAULT_ACTIVE_KID  which kid encrypts new versions.
// Old kids stay configured so previously wrapped DEKs still resolve.

export class VaultConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "VaultConfigError";
  }
}

/**
 * @param {Record<string,string>} [env] defaults to process.env (injectable in tests).
 * @returns {{ keys: Record<string, Buffer>, activeKid: string }}
 * @throws {VaultConfigError} when the active kid is missing or a key is malformed.
 */
export function loadVaultKeys(env = process.env) {
  const raw = env?.PODS_VAULT_KEYS;
  if (!raw) throw new VaultConfigError("PODS_VAULT_KEYS is not set.");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VaultConfigError("PODS_VAULT_KEYS is not valid JSON.");
  }
  const entries = Object.entries(parsed ?? {});
  if (entries.length === 0) throw new VaultConfigError("PODS_VAULT_KEYS has no keys.");
  const activeKid = env?.PODS_VAULT_ACTIVE_KID;
  if (!activeKid || !(activeKid in parsed)) {
    throw new VaultConfigError("PODS_VAULT_ACTIVE_KID must name a key in PODS_VAULT_KEYS.");
  }
  const keys = {};
  for (const [kid, base64] of entries) {
    const bytes = Buffer.from(String(base64), "base64");
    if (bytes.length !== 32) {
      throw new VaultConfigError(`Vault key "${kid}" must be 32 bytes (base64).`);
    }
    keys[kid] = bytes;
  }
  return { keys, activeKid };
}
