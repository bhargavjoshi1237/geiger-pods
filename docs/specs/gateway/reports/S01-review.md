# S01 review — Architecture, conventions & shared engine contracts

Reviewer: senior review pass over `docs/specs/gateway/reports/S01.md` and every file it lists,
plus `tests/s01/`. Next.js code was not touched, so `node_modules/next/dist/docs/` was not needed.
No `npm install` / `build` / `dev` / db / git-write commands were run. Only S01-listed files
plus `tests/s01/` were edited; `lib/gateway/core/phases/*`, `package.json` and
`package-lock.json` were not touched.

## Findings

| severity | file:line | defect | status |
|---|---|---|---|
| high | `lib/gateway/core/context.mjs` (`getPath`/`resolveVariable`) | Prototype-chain paths leaked native source: `resolveVariable(ctx, "context.constructor")` returned `"function Object() { [native code] }"` instead of `""`, violating the spec ("Unknown names resolve to `""`") and leaking implementation detail into mapping/log/authorizer outputs. Verified by execution. | fixed — `S01 review: context resolver returns empty string for prototype-chain paths` (blocked segments `__proto__`/`constructor`/`prototype`; only string/number/boolean values stringify, everything else is `""`) |
| medium | `lib/gateway/capabilities.mjs:74` (`supports`) | `supports(protocol, "__proto__")` (and `constructor`, `hasOwnProperty`, …) threw `TypeError: … .includes is not a function` via the inherited `Object.prototype`, instead of returning `false` fail-closed as documented. Verified by execution. | fixed — `S01 review: supports returns false for prototype-chain keys instead of throwing` (`Object.hasOwn` + `Array.isArray` guard) |
| medium | `lib/gateway/core/errors.mjs:22` (`GatewayError`) | `new GatewayError("__proto__")` / `("constructor")` did **not** throw: the inherited `Object.prototype` is truthy, so the unknown-type guard was bypassed and a bogus error with empty message / status 500 was created. Fail-closed violation. Verified by execution. | fixed — `S01 review: GatewayError rejects prototype-chain types` (`Object.hasOwn` check) |
| medium | `lib/gateway/core/limits.mjs:55` (`exceedsHeaderLimit`) | Header values were measured with UTF-16 `value.length` although the limit is `maxHeaderValueBytes` (10 KiB). A 6000-char / 12000-byte value was **not** flagged. Verified by execution. | fixed — `S01 review: header limit counts UTF-8 bytes not UTF-16 characters` (`TextEncoder` byte length; Web-API, edge-safe) |
| medium | `lib/gateway/state/redis-kv.mjs` (`INCR_BY_LUA`) | `incrBy` TTL semantics diverged from the documented memory behavior ("Keeps the existing TTL unless `opts.ttlMs` is given"): bare `SET` clears any existing TTL, so (a) `incrBy` without `ttlMs` dropped a previously set TTL, and (b) `incrBy` with `ttlMs` kept the stale TTL instead of overwriting (old code only expired when `PTTL < 0`). Found by inspection against documented Redis `SET` semantics. | fixed — `S01 review: memory incrBy keeps existing TTL unless overridden` + new shared contract case `kv contract (memory): incrBy preserves TTL unless ttlMs overrides`. New Lua snapshots `PTTL` before `SET` and restores it when no `ttlMs` is passed, overwrites with `PEXPIRE` when `ttlMs > 0`, deletes on `ttlMs == 0` (mirrors memory's immediate expiry). Redis-side execution skipped here (no `PODS_KV_URL`); memory side passes. |
| low | `lib/gateway/core/gateway-responses.mjs:127` (`resolveGatewayCustomization`, S06 block) | `table[type]` reads through the prototype chain: a `type` of `constructor`/`hasOwnProperty` returns a truthy inherited member instead of `null`. Same class of bug as fixed above. | reported-not-fixed — S06-owned lines in a shared file with concurrent agents editing the tree; `type` in practice comes from `GatewayError` types (now strictly validated), so impact is low. S06 owner should apply the same `Object.hasOwn` guard. |
| low | `lib/gateway/core/gateway-responses.mjs:147` (`resolveGatewayParameter`, S06 block) | `lookupGatewayHeader` uses `name in bag` (prototype chain: `constructor in {}` is true, leaking `String(Object)`), and `stageVariables[match[1]]` has no `__proto__` guard (the `context.` branch does). | reported-not-fixed — same reason as above (S06-owned, concurrent edits, low impact: values feed response headers, not code paths). |
| low | `lib/gateway/core/pipeline.mjs:113` (`runPipeline` fallback) | Fallback for unknown `protocol` values (e.g. `WEBSOCKET`, currently a no-op `match`) is the REST 403 `MISSING_AUTHENTICATION_TOKEN`. Spec S01 only defines REST→403 / HTTP→404, so this is spec-compliant today, but S12 should define the WebSocket behavior when it owns the phase. | reported-not-fixed — S12 scope; changing it now could break S12 expectations. |

## Areas reviewed with nothing significant found

- **Correctness vs spec/AWS:** gateway-response catalog (21 types, statuses, default messages) matches §5; pipeline `PHASE_ORDER` matches the §3 table row-for-row (also asserted by test); `x-pods-request-id` on every response and `x-pods-error-type` on gateway errors verified; CLF `requestTime` in UTC and ms `requestTimeEpoch` verified; `newPublicId` format/uniqueness and rejection sampling verified; token-bucket math (memory vs Redis Lua) matches the documented `rate`/`burst`/`retryAfterMs` semantics.
- **Security:** no RLS/SQL to review (S01 ships no migrations or DB code); no secret handling in S01 (default `secrets.resolve` throws fail-closed; artifacts carry no plaintext); no ReDoS surface (only simple anchored patterns); no timing-sensitive comparisons (auth is S07); non-`GatewayError` pipeline failures render fail-closed 500 `API_CONFIGURATION_ERROR`; `emit` errors are swallowed as specified.
- **Contract stability:** all §11 deliverables present with the specified exported names/signatures (`newPublicId`, `runPhases`/`runPipeline`, `buildContext`/`resolveVariable`/`formatClfTime`, `GatewayError`/`isGatewayError`, `statusFor`/`messageFor`/`renderGatewayError`, `LIMITS` + predicates, `PHASES`/`PHASE_ORDER` with 20 `name`+`run` entries, `MemoryKvStore`/`RedisKvStore`/`kvFromEnv`, `handle`/`createPorts`, test glob + `gateway:dev` in `package.json` verified present, `parity-status.md` has the reported 78 `planned` rows). Later-spec extension blocks in `capabilities.mjs` / `gateway-responses.mjs` / `match` phase are additive and untouched.
- **Test quality:** existing `tests/s01` tests assert on real behavior (no mocks, no tautologies). Gaps were the missing negative cases above, now covered.

## Final test outputs

- `node --test "tests/s01/**/*.test.mjs"`: 25 tests, 24 pass, 0 fail, 1 skipped (`kv-redis`, no `PODS_KV_URL` — same honest skip as S01).
- `node --test tests/*.test.mjs`: 16 tests, 16 pass, 0 fail.
- `npx eslint` over all six changed lib/test files: clean (exit 0).

Changed files (all S01-listed or `tests/s01/`): `lib/gateway/capabilities.mjs`,
`lib/gateway/core/errors.mjs`, `lib/gateway/core/context.mjs`, `lib/gateway/core/limits.mjs`,
`lib/gateway/state/redis-kv.mjs`, `tests/s01/review.test.mjs` (new), `tests/s01/kv-contract.mjs`.
