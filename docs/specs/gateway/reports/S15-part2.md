# S15 report — Part 2 (limits, benchmarks, wiring, parity audit)

Date: 8 October 2026 (UTC). Spec: `docs/specs/gateway/15-limits-hardening-audit.md`
§1, §3 (bench), §5. Part 1 (security) and the parallel pass (F7/F14/F16/
F27/F28/F29/F30/F35/F37) are reported in `reports/S15.md` and
`reports/S15-parallel.md`; this pass does not repeat them.

## What was already done (not repeated)

Limits table, bench harness, and all wiring below were implemented in the
working tree with green tests before the restart. This pass verified them
(`npm test`: 627 tests, 612 pass, 0 fail, 15 pre-existing `[db]`/env skips;
`npm run lint` clean; `npm run build` passes) and closed the remaining
audit artifacts (deviations, restore drill, parity-report regen, this report).

## Files (pre-existing, verified)

**Limits (S15 §1):**

- `lib/gateway/core/limits.mjs` — `LIMIT_TABLE` (single source of truth),
  `getLimit` (adjustable overrides via `project_settings.features.limits`),
  `exceedsCountLimit`, `limitUsage` (≥ 80 % near-cap for list screens).
- `lib/control/limits.mjs` — `assertCountWithinLimit` (409
  `limit_exceeded { limit, value }`), `assertSizeWithinLimit` (422).
- `scripts/gen-limits-doc.mjs` + `docs/limits.md` (generated; `--check`
  passes).
- Test: `tests/s15/limits.test.mjs` (sync check + one N/N+1 test per row).

**Benchmarks (S15 §3):**

- `bench/gateway-overhead.mjs` — in-process `handle()` overhead (MOCK, no
  auth); heavy gateway + Redis runs behind `PODS_BENCH_HEAVY=1`.
- `bench/results.json` — recorded run (p50 ~0.26 ms, p99 ~2.7 ms;
  CI asserts p99 ≤ 30 ms = 2× the 15 ms target to avoid flakiness).
- Test: `tests/s15/bench.test.mjs`.

**Wiring (parallel hand-offs closed):**

- F29: `gateway/server.mjs` wires `ports.cacheDek` (`PODS_CACHE_DEK` ≥ 8
  chars, `cacheDekRequired` in prod) + vault secret-name resolution;
  `gateway/loader.mjs#stageCacheDekRef`; `release/cache.mjs#resolveStageDek`
  (explicit → vault `cache-dek:<stage>` → derived). Tests:
  `tests/s15p/f29-cache-dek.test.mjs`, `tests/s15/f29-wiring.test.mjs`.
- F30: `release/cache.mjs` approximate LRU (`evictForStore`,
  `noteCacheStore`, `noteCacheHit`); `phases/method-response.mjs` evicts
  oldest-first instead of pure skip; `phases/cache-lookup.mjs` refreshes
  recency on hits. Tests: `tests/s15p/f30-cache-lru.test.mjs`,
  `tests/s15/f30-wiring.test.mjs`.
- F38: `lib/control/websocket.mjs#manageConnection` accepts a `gateway`
  client; the stage connections route forwards via `PODS_GATEWAY_URL` +
  service credential, else preserves 410. Test:
  `tests/s15/f38-connections.test.mjs` (live gateway round-trip).
- F32: `lib/gateway/core/integrations/http.mjs` closes the owned (per-request)
  dispatcher on every abort path; real-socket test in
  `tests/s15/f32-abort.test.mjs`.
- F18: case-insensitive multivalue lookups, `status_code` 100–599 validation
  with default fallback, byte-accurate UTF-8 `truncateBody`, casing-aware
  compression. Tests: `tests/s15/f18-mapping.test.mjs` (×4).
- F15: shared `lib/control/pagination.mjs` (`decodeCursor` strict
  ISO-timestamp + UUID, `parsePaging`, `toPage`); all services delegate.
  Tests: `tests/s15/f15-pagination.test.mjs`.
- F49: `redos.mjs#validateSafePattern` rejects named capture groups
  (`(?<name>…)`/`(?P<name>…)`). Test: `tests/s15/f49-redos-named.test.mjs`.

## Parity audit (this pass)

- `parity-status.md` already carried honest `implemented` rows for the seven
  engine/unit-only areas (S09 stage cache; S10 access logs, execution logs,
  sinks, tracing, alarms, audit trail) with "no gateway-host runtime test
  yet" notes. `parity-report.md` was stale (7 beyond evidence); regenerated:
  `node scripts/parity-report.mjs` → **0 rows beyond evidence**.
- `docs/specs/gateway/deviations.md` created (six spec-named deviations +
  gateway-wide S15 deviations with evidence links).
- `docs/ops/restore.md` created (backup = S14 export + vault ciphertext;
  drill steps; RPO = DB PITR, RTO ≤ 1 h; honest gaps).
- `docs/specs/gateway/production-evidence/README.md` created (pending list
  per §5.3; no row is `production-validated`).
- `docs/limits.md` sync verified (`--check` passes).

## Acceptance tests (Part 2 scope)

| Spec test | Result | Evidence |
|---|---|---|
| `S15: limits.mjs and docs/limits.md in sync; each limit enforced (N/N+1)` | pass | `tests/s15/limits.test.mjs` |
| `S15: bench results recorded; p99 thresholds asserted at 2× target` | pass | `tests/s15/bench.test.mjs`, `bench/results.json` |
| `S15: parity-report generated with no row marked beyond its evidence` | pass | `scripts/parity-report.mjs` → 0 beyond evidence |

Security/robustness suites from Part 1 + parallel still pass
(`tests/s15/*.test.mjs` + `tests/s15p/*.test.mjs`: 71 pass, 3 `[db]` skips).

## Incomplete / open (honest list)

- **F7:** no live Postgres here; `[db]` tests skip. To close: set
  `PODS_TEST_DB_URL` and run any `[db]` test.
- **F25 (usagePlans):** `domains`/`waf`/`portals` stack kinds registered;
  `usagePlans` kind still open.
- **F43:** SDK jobs in-process (`lib/control/sdks.mjs`); persist to
  `pods.sdk_jobs` for multi-instance.
- **F45:** portal custom domains CRUD-only; needs host rewrite + verification.
- **Metering (spec §4):** `pods.metering_daily` + rollup + settings UI not
  implemented (metering-only, no charging).
- **Production validation (spec §5.3):** not run; evidence dir holds the
  pending checklist.
- **Roadmap/landing claims (spec §5.4):** `lib/workspace/roadmap.js` phase 10
  has no status; no landing-page claims were added (nothing claimed without
  evidence).

## Addendum — F50 stage-observability wiring + host proofs (8 Oct 2026, UTC)

After the pass above, a close-out sweep found the S10 control plane was
disconnected from the gateway runtime: nothing populated `ctx.stageSettings`
/ `artifact.stageSettings` on the host path, so access logs, execution logs
and traces silently never emitted; the `default_logging_level` /
`default_data_trace` columns did not exist; `$context.status` never rendered.
Fixed without touching the pass above (all additive):

- `gateway/loader.mjs#stageObservabilityFromRow` + `resolved.stageObservability`
  (memory entries, Supabase fresh/`$default` reads; stage select extended);
  `gateway/server.mjs` copies it to `ctx.stageSettings`; emit backfills
  `$context.status` from the finished event.
- Migration `20261019000001_stage_observability_defaults.sql` adds the two
  columns.
- New: `tests/s10/stage-observability.test.mjs` (mapping, migration
  contract, `[runtime]` rows/spans flow + off-by-default), and
  `tests/s09/cache-host.test.mjs` (second GET served from cache via a real
  gateway).
- Parity upgrades: S09 stage cache, S10 access logs, execution logs, log
  destinations, tracing → `runtime-tested`; alarms + audit trail stay
  `implemented` (control-plane only, no gateway path). Regenerated:
  `node scripts/parity-report.mjs` → **0 rows beyond evidence**.
- New follow-ups: F50 (closed here), F51 (byte counts always null — open).
