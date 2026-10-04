# S10 — Observability: metrics, access & execution logs, tracing, alarms, audit

**Wave 4 · Depends on: S05 · Enhances every runtime spec**

AWS references: [REST metrics](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-metrics-and-dimensions.html), [HTTP metrics](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-metrics.html), [WebSocket metrics](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-logging.html), [REST logging (access & execution)](https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-logging.html), [HTTP access logging variables](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-logging-variables.html), [Firehose access logs](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-logging-to-kinesis.html), [X-Ray tracing](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-xray.html), [CloudWatch alarm evaluation](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/AlarmThatSendsEmail.html), [CloudTrail](https://docs.aws.amazon.com/apigateway/latest/developerguide/cloudtrail.html).

**Rule:** every chart, count and log line comes from real runtime events. No sample or placeholder traffic is ever shown. Test-invoke traffic (S05) is excluded.

## 1. Request event (`observe/event.mjs`)

Phase 20 builds one event per request **after** the response completes. It runs via `queueMicrotask`/`setImmediate`, never on the response path:

```js
{ ts, requestId, extendedRequestId, projectId, apiId, apiPublicId, protocol, stage, canary, deploymentId,
  routeKey, resourcePath, httpMethod, status, errorType, latencyMs, integrationLatencyMs, authorizerLatencyMs,
  requestBytes, responseBytes, cache: "hit"|"miss"|null, apiKeyId, principalId, sourceIp, userAgent,
  throttled, quotaRejected, wafAction, domainName, traceId, kvFallback, connectionId?, eventType? }
```

`EventSink` (S01 port): an in-memory bounded queue (10 000 events). When full, it drops the oldest and increments `droppedEvents`. Consumers: the metrics aggregator (§2), the access-log writer (§3), usage rollup (S08 `usage_daily`) and trace exporter (§5). Each consumer fails independently.

## 2. Metrics (`observe/metrics.mjs`)

| Protocol | Metrics |
|---|---|
| REST | `Count`, `4XXError`, `5XXError`, `Latency`, `IntegrationLatency`, `CacheHitCount`, `CacheMissCount` |
| HTTP | `Count`, `4xx`, `5xx`, `Latency`, `IntegrationLatency`, `DataProcessed` |
| WebSocket | `ConnectCount`, `MessageCount`, `IntegrationError`, `ClientError`, `ExecutionError`, `IntegrationLatency` |
| Pods extras | `ThrottleCount`, `QuotaRejectCount`, `AuthorizerLatency`, `KvFallbackCount`, `DroppedEvents`, `CacheStoreSkipped` |

- **Dimensions:** `ApiId`, `Stage` (`{stage}/Canary` for canary traffic), and, when **detailed metrics** are enabled for the stage/method (`method_settings.metricsEnabled` / `route_settings.detailedMetricsEnabled`), `Resource`+`Method` (REST) or `Route` (HTTP/WS).
- **Aggregation:** each runtime instance aggregates per minute in memory: counts, sums and a fixed log-scale latency histogram (64 buckets, 1 ms–60 s), which is mergeable. It flushes every 60 s (and on shutdown) by upserting into `pods.metrics_minute (project_id, api_id, stage, dims_hash, dims jsonb, minute timestamptz, metric text, sum, count, min, max, hist int[])`, using `on conflict … do update` that **adds**.
- **Retention** (CloudWatch-like): minute rows 15 days. A job rolls up to `pods.metrics_hour` and keeps it 455 days. The job is `app/api/internal/jobs/rollup/route.js`, triggered by Vercel Cron and protected by `CRON_SECRET`.
- **Query API** `GET /api/v1/projects/{p}/metrics?metric=&apiId=&stage=&dims=&stat=Sum|Average|Minimum|Maximum|SampleCount|p50|p90|p95|p99&period=60|300|3600|86400&from=&to=` → `{ series: [{ts, value}] }`. Percentiles come from merged histograms. Permission: `pods.monitoring.view`.

## 3. Access logs (`observe/access-log.mjs`)

- **Stage setting** `stages.access_log = { enabled, format, destinations: [ "pods" | sinkId ] }`. The format is a string with `$context.*` variables (S01 §4), ≤ 3 KB (AWS). Presets, matching the AWS console exactly:
  - **CLF:** `$context.identity.sourceIp $context.identity.caller $context.identity.user [$context.requestTime] "$context.httpMethod $context.resourcePath $context.protocol" $context.status $context.responseLength $context.requestId`
  - **JSON:** `{ "requestId":"$context.requestId", "ip": "$context.identity.sourceIp", "caller":"$context.identity.caller", "user":"$context.identity.user","requestTime":"$context.requestTime", "httpMethod":"$context.httpMethod","resourcePath":"$context.resourcePath", "status":"$context.status","protocol":"$context.protocol", "responseLength":"$context.responseLength" }`
  - **XML** and **CSV** presets as in the AWS console.
  - Validation: the format must contain `$context.requestId` or `$context.extendedRequestId` (AWS requirement). Unknown variables → 422.
- **Storage:** `pods.access_logs (project_id, api_id, stage, ts, request_id, status, route, source_ip, line text, fields jsonb)`, partitioned daily (`pg_partman` is not assumed; a daily job creates the partitions). Retention is `project_settings.log_retention_days`, and a job drops old partitions.
- **Writers** batch-insert every 1 s or 500 rows.

## 4. Execution logs (REST/WS, `observe/execution-log.mjs`)

- Per-method/route `loggingLevel`: `OFF | ERROR | INFO`, and `dataTraceEnabled`. Both live in `stages.method_settings` / `route_settings`.
- Each pipeline phase appends lines through `ctx.trace(level, message)`, in the AWS message vocabulary: `Extended Request Id: …`, `Verifying Usage Plan for request: …`, `API Key … authorized because method 'GET /pets' requires API Key and API Key is not associated with a Usage Plan…`, `Method request path: {…}`, `Method request query string: {…}`, `Method request headers: {…}`, `Method request body before transformations: …`, `Endpoint request URI: …`, `Endpoint request headers: {…}`, `Endpoint request body after transformations: …`, `Sending request to …`, `Received response. Status: 200, Integration latency: 45 ms`, `Endpoint response headers: {…}`, `Endpoint response body before transformations: …`, `Method response body after transformations: …`, `Method response headers: {…}`, `Successfully completed execution`, `Method completed with status: 200`, plus authorizer, cache and throttle lines.
- **Redaction (always, even with data trace on):** `authorization`, `proxy-authorization`, `cookie`, `set-cookie` values, `x-api-key` (shown as the last 4 chars), any header injected by `backend_auth` (S04), and any value equal to a resolved secret → `****`.
- **Data trace:** bodies are included only when `dataTraceEnabled`, truncated to 1 KB each. Stored separately with `data_trace_retention_days`. Viewing requires `pods.logs.data`.
- **Storage:** `pods.execution_logs (project_id, api_id, stage, request_id, ts, level, lines jsonb)`, with the same partitioning and retention.
- Test invoke (S05) reuses this formatter for its `log` field.

## 5. Tracing (REST, `observe/tracing.mjs`)

- `stages.tracing_enabled`. Sampling rules at project level: `pods.sampling_rules (priority, reservoir_per_sec, fixed_rate, match: {host, method, path glob, apiId, stage})`. The default rule is 1 req/s reservoir + 5 % (X-Ray default).
- **Propagation:** accept the inbound `traceparent`/`tracestate` (W3C) or `X-Amzn-Trace-Id` (`Root=1-…;Parent=…;Sampled=1`, converted to W3C). Always forward `traceparent` to integrations. Echo `traceparent` in responses only when `features.echoTraceparent` is set. `$context.traceId`.
- **Spans:** `gateway` (root/server), with children `waf`, `authorizer`, `cache`, `integration` (client span with `http.*` semantic-convention attributes), `function`.
- **Export:** OTLP/HTTP JSON to `project_settings.features.otlpEndpoint`, with auth headers from a vault secret, in batches. Built-in viewer: sampled spans stored 7 days in `pods.trace_spans`, shown as a waterfall per request id.

## 6. Log & event export (Firehose equivalent)

`pods.log_sinks`: `name`, `type` (`https` | `s3` | `otlp_logs`), `config` (`https`: url, HMAC secret ref; `s3`: bucket, prefix, region, endpoint for S3-compatible, credentials secret ref; `otlp_logs`: endpoint, headers secret ref), `status`, `last_delivery_at`, `last_error`.
Delivery: `https` = NDJSON batches ≤ 1 MB or every 5 s, signed `x-pods-signature`, with retry/backoff for 24 h and then dropped and counted. `s3` = gzip NDJSON objects `prefix/yyyy/mm/dd/HH/{instance}-{seq}.ndjson.gz` every 5 min or 64 MB. A stage access-log `destinations` entry may reference a sink. Permission: `pods.export.write`.

## 7. Alarms (CloudWatch-alarm equivalent)

- `pods.alarms`: `name`, `description`, `metric`, `dimensions`, `statistic`, `period_sec` (multiple of 60), `evaluation_periods`, `datapoints_to_alarm`, `comparison` (`>`, `>=`, `<`, `<=`), `threshold`, `treat_missing_data` (`missing|notBreaching|breaching|ignore`), `actions` (`{ok:[channelId], alarm:[…], insufficientData:[…]}`), `state` (`OK|ALARM|INSUFFICIENT_DATA`), `state_reason`, `state_updated_at`, `enabled`.
- `pods.notification_channels`: `type` (`webhook` | `slack_webhook` | `email`), config (URL in vault). Email uses the Geiger suite mailer if one is available; otherwise it is hidden.
- **Evaluator** (`app/api/internal/jobs/alarms/route.js`, every minute): CloudWatch "M out of N" semantics using `metrics_minute`. A state change writes `pods.alarm_history` and sends notifications exactly once per transition (idempotency key `alarmId:stateUpdatedAt`).

## 8. Audit trail UI (CloudTrail equivalent)

`/audit`: filter by actor, action, resource type/id, API and time. Each entry shows a before/after JSON diff (already redacted by S02). Export CSV. Retention is unlimited by default; a project setting can set it to ≥ 90 days.

## 9. Screens

- **Monitoring** (`/monitoring`): API/stage selectors; charts for Count, 4XX, 5XX, Latency p50/p90/p99 and Integration latency, plus cache hit ratio (REST), data processed (HTTP), connections/messages (WS); top routes by errors/latency when detailed metrics are on; "No traffic yet" empty state.
- **Logs** (`/monitoring/logs`): access-log search (time, stage, status class, route, request id, source IP), live tail (2 s polling), and a request detail drawer combining the access line, execution log (if any) and trace waterfall (if sampled).
- **Stage → Logs & tracing** sub-tab: access-log toggle and format presets/editor with live preview against a sample context, destinations, execution-log level, data trace (with a warning), detailed metrics, and tracing toggle.
- **Alarms** (`/monitoring/alarms`): list with state badges, create wizard (metric → condition → actions), and history.
- **Export** (`/settings/exports`): sinks CRUD and a test-delivery button.
- **Overview** (Phase‑0 screen): add real 24 h counts (requests, errors, p90) from `metrics_hour`/`metrics_minute`.

## Acceptance tests

- `S10: emitting is off the response path — a slow sink does not increase request latency (bounded queue drops and counts)`.
- `S10 [runtime]: 100 requests (90×200, 7×404, 3×502) → Count 100, 4XXError 7, 5XXError 3 in metrics_minute; two instances' rows sum correctly`.
- `S10: histogram percentile p50/p99 within one bucket of exact values`.
- `S10: canary traffic recorded under "{stage}/Canary"`.
- `S10: CLF and JSON presets render exactly the AWS strings for a fixture context; format without requestId rejected`.
- `S10: execution log contains AWS-vocabulary lines in order for a REST HTTP integration; ERROR level only logs failures`.
- `S10: Authorization, cookies, x-api-key and backend_auth values are masked even with data trace; bodies only with data trace and truncated to 1 KB`.
- `S10: inbound X-Amzn-Trace-Id converted; traceparent forwarded to upstream; sampling reservoir 1/s + 5% respected (seeded)`.
- `S10: https sink receives signed NDJSON; failing sink retries with backoff and does not block others`.
- `S10: alarm 2-of-3 datapoints breaching → ALARM once; treatMissingData variants; notification sent exactly once per transition`.
- `S10: retention job drops partitions older than log_retention_days`.
- `S10 [db]: member can view metrics and access logs; cannot view data-trace bodies without pods.logs.data`.
