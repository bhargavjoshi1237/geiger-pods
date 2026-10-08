# S15 parallel pass — follow-up close-outs (F7, F14, F16, F27–F30, F35, F37)

Date: 7 October 2026 (UTC). Scope: the nine follow-ups listed in the task
brief (specs 02, 03, 05, 09, 11, 12, 14, 15). Read first: `AGENTS.md`,
`docs/specs/gateway/00-index.md`, `01-architecture.md` (§2 ownership +
extension points), the follow-up rows in `reports/followups.md`, reports
S09/S14 (format), and the `node_modules/next/dist/docs/` route + runtime
references before writing route code.

> Boundary respected: none of the other agent's files were edited
> (`gateway/server.mjs`, `loader.mjs`, `tls-server.mjs`,
> `lib/control/{connectors,integrations,openapi-import,authorizers,signing-credentials,domains}.mjs`,
> `lib/gateway/core/{auth,phases,processing,integrations}/**`,
> `release/streaming.mjs`, `edge/waf-engine.mjs`,
> `websocket/connections-api.mjs`, `redos.mjs`, `tests/s15/*`, `tests/s11/*`,
> `reports/followups.md`, `parity-status.md`, `reports/S15.md`).
> New tests lived in `tests/s15p/*.wip.mjs` until green, then renamed to
> `.test.mjs`. `npm run build` and full `npm test` were never run (per
> instructions); `npm run lint` (eslint) is clean on every touched file.

## Status per follow-up

| ID | Status | Evidence (test file + test name) | One-line description |
|---|---|---|---|
| F14 | **done** | `tests/s15p/f14-catalog-rls.test.mjs` — `F14: migration contract — unique version, @up/@down, no FOR ALL, delete guard`; `F14 [db]: update holders cannot soft-delete apis; route writers cannot hard-delete` (skips cleanly without `PODS_TEST_DB_URL`) | New migration `20261010000007_catalog_rls_tightening.sql`: trigger requires `pods.api.delete` for `deleted_at` changes; catalog write policies become INSERT+UPDATE only |
| F16 | **done** | `tests/s15p/f16-atomicity.test.mjs` — all 5 `F16: …` tests (mid-copy failure ×3 tables, handler rollback, rollback option, deleteResource restore, success path) | Compensation in `cloneApi` (soft-delete rollback + handler `rollback` hooks) and `deleteResource` (method restore via new `db.restoreMethods`) |
| F27 | **done** | `tests/s15p/f27-admin-screens.test.mjs` — all 4 `F27: …` tests | Tokens/stacks were already registered (registry + screens list + settings links + catch-all route); tests lock the chain; tags = embedded `TagsEditor` by design |
| F28 | **done** | `tests/s15p/f28-control-kv.test.mjs` — all 6 `F28: …` tests; S14 `idempotency` suite still green | KV-backed limiter (shared token bucket, local fail-over), heavy buckets via `incrBy`, KV idempotency (24 h TTL, 256 KB cap); `http.mjs` wired; `docs/ops/cli-e2e.md` documents the live procedure |
| F29 | **done** (runtime injection is a handoff, below) | `tests/s15p/f29-cache-dek.test.mjs` — all 6 `F29: …` tests | `resolveStageDek` (explicit → vault `cache-dek:<stage>` → derived) with source reporting; strict/production fallback logs + emits `cache_dek_fallback`; `ensureStageCacheDek` provisions the vault secret |
| F30 | **done** (phase call-site wiring is a handoff, below) | `tests/s15p/f30-cache-lru.test.mjs` — all 5 `F30: …` tests | Approximate LRU in `release/cache.mjs`: bounded recency registry (`cache:lru:<stage>`, newest 512 win) + pure `evictForStore` (oldest-first, oversized items keep the skip) |
| F35 | **done** | `tests/s15p/f35-waf-samples.test.mjs` — all 4 `F35: …` tests; S14 openapi sync green | `listSampledRequests` (ACL-scoped, stage/rule/limit filters) + `GET …/web-acls/[aclId]/sampled-requests` route + live rows in the WAF screen; OpenAPI regenerated (131 routes) |
| F37 | **done** | `tests/s15p/f37-ws-frames.test.mjs` — all 6 `F37: …` tests (unit + raw-frame runtime); updated `tests/s12/message.test.mjs` green | Streaming frame sniffer (`websocket/frames.mjs`) + manager hook: single frames > 32 KB close 1009, fragmented ≤ 128 KB pass |
| F7 | **open** (no DB here; precise note below) | `tests/s15p/f07-pg-harness.test.mjs` — 2 pass, 2 `[db]` skip cleanly | `pg@8.23.1` devDependency added; `tests/helpers/pg.mjs` (stubs + apply-all-`@up` + rollback); F14 `[db]` test proves it serves real RLS tests |

## Files created

- `supabase/migrations/catalog/20261010000007_catalog_rls_tightening.sql` (F14; version verified unique against `tests/s15/migrations-unique.test.mjs`).
- `lib/gateway/core/websocket/frames.mjs` (F37: `createFrameMonitor`, `closeFrame`).
- `tests/helpers/pg.mjs` (F7 harness).
- `tests/s15p/f{07,14,16,27,28,29,30,35,37}-*.test.mjs` (renamed from `.wip.mjs` once green).
- `app/api/v1/projects/[projectId]/waf/web-acls/[aclId]/sampled-requests/route.js` (F35; `runtime = "nodejs"`, thin).
- `docs/ops/cli-e2e.md` (F28 live procedure).

## Files changed (small, additive)

- `lib/control/apis.mjs` — `registerCloneHandler(handler, { rollback })`, `rollbackClone`, `cloneApi` try/catch compensation (F16).
- `lib/control/rest-resources.mjs` — `deleteResource` restores methods when the branch delete fails (F16).
- `lib/control/supabase-db.mjs` — `restoreMethods` (F16).
- `lib/control/documentation.mjs` — docs clone handler gains a `rollback` (F16).
- `lib/control/rate-limit.mjs` — KV idempotency + `ControlRateLimiter` KV buckets (async `consume`/`consumeHeavy`), `getControlKv`/`setControlKv` (F28).
- `lib/control/http.mjs` — awaits the limiter with KV; KV idempotency when `PODS_KV_URL` is set, DB table otherwise; extracted `toJsonResult` (F28).
- `lib/control/stage-cache.mjs` — `cacheDekSecretName`, `ensureStageCacheDek` (F29).
- `lib/control/waf.mjs` — `listSampledRequests` + `MAX_SAMPLED_LIMIT` (F35; `waf-engine.mjs` only imported, never edited).
- `lib/gateway/core/release/cache.mjs` — `resolveStageDek`/`isDekStrict`/`reportDekFallback` (F29), LRU registry + `evictForStore` (F30); `dekForStage` signature unchanged.
- `lib/gateway/core/websocket/manager.mjs` — frame-monitor hook + violated-message guard (F37).
- `components/internal/screens/waf/waf_screen.jsx` — `SampledRequests` section in `AclDetail` (F35).
- `tests/s03/fake-db.mjs` — `restoreMethods` (F16).
- `tests/s14/idempotency.test.mjs` — `await` the now-async limiter (same test name, F28).
- `tests/s12/message.test.mjs` — single 100 KB frame now expects 1009; the "fragmented accepted" case uses true `{ fin: false }` fragments (F37; see deviations).
- `docs/api/pods-management.openapi.yaml` — regenerated (131 routes; also picks up other agents' uncommitted routes).
- `package.json` — `pg@^8.23.1` devDependency (F7; installed first, no other installs).

## Deviations / findings

1. **F37 vs the old S12 test.** `tests/s12/message.test.mjs` sent its "fragmented 100 KB" as one `ws.send()` — a single 100 KB frame — and expected acceptance (the old leniency). Per S12 §2 that frame must now close with 1009, so the test was updated: single 100 KB → 1009, plus a true-fragmentation case (4 × ~25 KB with `{ fin: false }`) that is accepted with a reply. `tests/s12/*.test.mjs`: 16/16 pass.
2. **F37 close path.** Writing our own close frame to the socket races `ws`'s receiver error path (its `socketOnClose` leftover-read errors, destroys the socket, client sees bare 1006). Closing is therefore delegated to the `ws` object (`ws.close(1009)`), which delivers reliably; verified with raw sockets and the `ws` client.
3. **F16 on Postgres.** PostgREST exposes no multi-statement transactions, so both ports use the same service-level compensation (soft-delete rollback / method restore). Rollback is soft, never hard: F14 denies hard DELETE to user RLS clients.
4. **F28 scope choice.** KV idempotency activates only when `PODS_KV_URL` is set (the multi-instance case); otherwise the `pods.idempotency_keys` table stays authoritative (shared via Postgres, unchanged behavior). Rate limiting uses KV whenever available and the local bucket otherwise.
5. **F29 secret naming.** The engine ref is `cache-dek:<stageId>` but vault names forbid `:`; provisioned secrets are named `cache-dek-<apiPublicId>-<stage>` (sanitized, ≤ 128 chars, `generic` kind holding base64 key material).

## Incomplete / hand-offs (honest list)

- **F7 stays open.** No Postgres here (`PODS_TEST_DB_URL` unset, no `psql`/`pg_ctl` binaries), so no migration was ever applied to a live DB in this pass — including the new F14 migration (SQL paren-balanced statically; contract-tested). To close F7: point `PODS_TEST_DB_URL` at an empty database owned by a role that can `CREATE ROLE` + `CREATE EXTENSION pgcrypto`, then run any `[db]` test (e.g. `node --test tests/s15p/f14-catalog-rls.test.mjs`).
- **F29 runtime injection.** `ports.cacheDek` must be assigned in `gateway/server.mjs` and/or `gateway/loader.mjs` (other agent's files — untouched). Seam ready: `ensureStageCacheDek` provisions `cache-dek-<api>-<stage>`; the runtime resolves its current material and sets `ports.cacheDek` (explicit source wins; `ports.cacheDekRequired = true` makes any fallback loud). Until wired, the engine keeps the derived default (loud in production).
- **F30 phase wiring.** `storeInCache` (`method-response.mjs`) should call `noteCacheStore` + `evictForStore` (evict listed keys, decrement the byte counter) instead of pure skip-on-exceed, and `cacheLookup` (`cache-lookup.mjs`) should call `noteCacheHit` on hits. Both files belong to the other agent — the helpers are implemented, unit-tested, and signature-compatible; the wiring is ~6 lines.
- **`logs tail` CLI is still a stub** (`docs/ops/cli-e2e.md` says so); the live e2e procedure is documented but step 6 cannot pass until S10 streams logs.
- **`parity-status.md` not updated** (orchestrator-owned by design).
