# Restore drill (S15 §3 recovery)

Backup for one project:

1. `pods export` — project config in `pods apply`-format (S14 stacks:
   `POST /stacks/{stack}/apply` converges; `GET /apis/{api}/export` for
   OpenAPI/Postman snapshots).
2. Vault ciphertext — export the vault (secrets, signing credentials,
   `cache-dek-<api>-<stage>` DEKs from `ensureStageCacheDek`, gateway
   `PODS_GATEWAY_CONNECTIONS_SECRET` service credential) via the vault
   backup path. Never commit plaintext.

Restore:

1. Provision an empty database + vault, set `PODS_TEST_DB_URL` /
   `PODS_KV_URL` and service credentials (`PODS_GATEWAY_URL`,
   `PODS_GATEWAY_CONNECTIONS_KEY/SECRET` for `@connections`).
2. `pods apply` the exported stack file (prune only after review).
3. Restore vault ciphertext, then redeploy stages and verify
   `parity-report.md` evidence tests pass.

RPO = DB PITR window. RTO ≤ 1 h (control plane + gateway redeploy).

Honest gaps: SDK jobs are in-process (F43 — regenerate after restore);
`logs tail` CLI is a stub until S10 streams logs (see `docs/ops/cli-e2e.md`);
no live-DB proof here (F7 — `[db]` tests skip without `PODS_TEST_DB_URL`).
