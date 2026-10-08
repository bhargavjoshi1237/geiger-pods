# Production evidence (S15 §5.3)

No row is `production-validated` yet. This directory will hold the evidence
when the production validation runs.

Required per spec S15 §5.3 (marks rows `production-validated`):

- Runtime deployed in ≥ 2 instances behind a real wildcard domain with real TLS.
- A custom domain with a managed certificate.
- mTLS with a real CA.
- A connector across a real NAT.
- A 24 h soak at 500 rps with canary and cache enabled.
- A WebSocket soak of 10k connections for 2 h.

Evidence to file here: dashboards, logs, and timestamps per run.

Current state: `parity-report.md` gate is 0 rows beyond evidence
(`implemented`/`runtime-tested` only). Live-database proof is also missing
(F7: `PODS_TEST_DB_URL` unset, `[db]` tests skip).
