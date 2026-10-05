/**
 * Injected ports (dependency-injection boundaries for the engine core).
 *
 * JSDoc typedefs only — no runtime code. The engine core is pure ES:
 * input is a Web `Request` plus a compiled artifact, output is a Web
 * `Response`. No Next.js, Supabase or Node-only APIs except through
 * these ports. All feature logic lives here and is unit-tested with
 * `node --test`.
 *
 * @module lib/gateway/core/ports
 */

/**
 * @typedef {object} KvStore
 * @property {(key: string) => Promise<string | null>} get
 * @property {(key: string, value: string, opts?: { ttlMs?: number }) => Promise<void>} set
 * @property {(key: string) => Promise<void>} del
 * @property {(key: string, n: number, opts?: { ttlMs?: number }) => Promise<number>} incrBy
 * @property {(key: string, opts: { rate: number, burst: number, cost?: number }) => Promise<{ allowed: boolean, remaining: number, retryAfterMs: number }>} tokenBucket
 *   Atomic token-bucket check (a Lua script in Redis; a single-threaded map in memory).
 * @property {((channel: string, message: string) => Promise<void> | void) | undefined} [publish]
 * @property {((channel: string, fn: (message: string) => void) => (() => void) | Promise<() => void>) | undefined} [subscribe]
 */

/**
 * Server-side only secret resolver (S02 vault).
 * @typedef {object} SecretResolver
 * @property {(ref: string) => Promise<string>} resolve
 */

/**
 * Request-event sink (S10). Post-response, never blocks.
 * @typedef {object} EventSink
 * @property {(event: object) => void} emit
 */

/**
 * Deterministic clock (the memory KV uses the injected clock so tests are deterministic).
 * @typedef {object} Clock
 * @property {() => number} now
 */

/**
 * @typedef {object} Ports
 * @property {typeof fetch} fetch
 * @property {KvStore} kv
 * @property {SecretResolver} secrets
 * @property {EventSink} events
 * @property {Clock} clock
 * @property {(...args: Array<unknown>) => void} log
 * @property {SigningCredentialStore | undefined} [signingCredentials] - S07 consumer SigV4 credentials.
 * @property {SigningPolicyStore | undefined} [signingPolicies] - S07 identity policies.
 */

/**
 * Consumer SigV4 credential lookup (S07 §3, §6).
 * @typedef {object} SigningCredentialStore
 * @property {(accessKeyId: string) => Promise<{ secretAccessKey: string, status?: string } | null>} resolve
 */

/**
 * Identity-policy lookup for one signing credential (S07 §6).
 * @typedef {object} SigningPolicyStore
 * @property {(accessKeyId: string) => Promise<Array<object>>} list
 */

export {};
