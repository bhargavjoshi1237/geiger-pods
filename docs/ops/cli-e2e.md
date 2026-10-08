# CLI live end-to-end procedure (S14 §3, F28)

This is the manual live run that the stub-client CLI tests
(`tests/s14/cli.test.mjs`) do not cover: login → `apis create` → `deploy` →
`logs tail` sees a request. It needs a running Next app **and** a database
(the same `PODS_TEST_DB_URL` backing as the `[db]` tests).

## Prerequisites

- `npm run dev` (or `next start` after `npm run build`) serving the app at
  `$BASE` (default `http://127.0.0.1:3000`).
- A project id and a personal access token with scopes covering
  `pods.api.create`, `pods.deployment.create`, `pods.stage.write`,
  `pods.logs.view` (create it at `/settings/tokens`, expiry ≤ 1 y).
- `curl` (or any HTTP client) for the data-plane request.

## Procedure

```bash
export PODS_BASE_URL="$BASE" PODS_PROJECT="<projectId>"

# 1. Login (stores the profile at ~/.config/pods/config.json).
node cli/pods.mjs login --token "<pods_pat_…>"

# 2. Sanity: whoami resolves flag > env > profile.
node cli/pods.mjs whoami

# 3. Create an API (first POST may carry an Idempotency-Key; a replay
#    returns the stored response, a changed body → 422).
node cli/pods.mjs apis create --name e2e-shop --protocol REST

# 4. Deploy it to a stage.
node cli/pods.mjs deploy --api e2e-shop --stage prod

# 5. Send one data-plane request through the stage URL from `stages list`
#    (or `pods test-invoke --api e2e-shop --resource / --method GET`).
curl -s -o /dev/null -w "%{http_code}\n" \
  "http://127.0.0.1:3000/gw/<apiPublicId>/prod/"

# 6. Tail the logs and confirm the request shows up.
node cli/pods.mjs logs tail --api e2e-shop --stage prod
```

Expected: step 3 prints the created API (`201`, one row in the human
table), step 4 prints the deployment with `stageName: prod`, step 5 returns
the gateway status for `/`, and step 6 streams (or lists) the access-log
row for that request id.

## Multi-instance notes (F28)

- Control-plane rate limiting (10 rps sustained, burst 40 per project, 429 +
  `Retry-After`) and POST idempotency share state through the KV port
  (`lib/gateway/state/`, `PODS_KV_URL`). With `PODS_KV_URL` set, run the
  procedure against two app instances behind one URL and confirm a
  replayed `Idempotency-Key` returns the stored response from either
  instance, and that > 40 bursty `apis list` calls return 429 with
  `retry-after` from either instance.
- Without `PODS_KV_URL` the rate limiter uses its in-memory default and
  idempotency stays on the `pods.idempotency_keys` table (shared through
  Postgres, as before): single-instance behavior is unchanged.
- If KV is down, the control plane fails open to the per-instance bucket
  (still limited) and idempotency checks miss (replays may re-execute:
  keep POSTs retry-safe).

## Known gaps (honest)

- `logs tail` is still a stub (`S10 logs tail (log streaming)`): step 6
  cannot pass until S10 streams logs to the CLI. Until then, verify the
  request in the Monitoring → Logs screen or via
  `GET /api/v1/projects/{p}/logs`.
- `pods deploy` of a WEBSOCKET/HTTP API and `stages rollback/flush-cache`
  follow the same shape; usage-plan/domain/WAF commands are thin stubs
  until their specs land.
