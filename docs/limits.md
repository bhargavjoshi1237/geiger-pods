# Pods limits

Defaults match AWS (S15 §1). Columns: **adjustable** means a project
override in `project_settings.features.limits` (set by Geiger staff via
SQL, not by users). Every limit has one constant in
`lib/gateway/core/limits.mjs`; this doc is generated from that module by
`scripts/gen-limits-doc.mjs` (a test checks they stay in sync).

| Limit | Default | Adjustable |
|---|---|---|
| APIs per project (regional) | 600 | yes |
| APIs per project (private) | 600 | yes |
| APIs per project (edge) | 120 | yes |
| Resources per REST API | 300 | yes |
| Routes per HTTP API | 300 | yes |
| Routes per WebSocket API | 300 | yes |
| Integrations per HTTP API | 300 | yes |
| Stages per API | 10 | yes |
| Stage variables per stage (key 64, value 512 chars) | 100 | no |
| Authorizers per API | 10 | yes |
| JWT audiences per authorizer | 50 | no |
| Scopes per route | 10 | no |
| Models size per API (bytes) | 409,600 (400 KB) | no |
| Documentation parts per API | 2,000 | yes |
| API keys per project | 10,000 | no |
| Usage plans per project | 300 | yes |
| Usage plans per key | 10 | yes |
| Method throttles per plan stage | 20 | yes |
| Custom domains per project (public) | 120 | yes |
| Custom domains per project (private) | 50 | yes |
| Multi-level mappings per domain | 200 | no |
| Routing rules per domain | 50 | yes |
| Connectors per project | 20 | yes |
| Client certificates per project | 60 | yes |
| Trust store certs | 1,000 | no |
| Trust store bytes | 1,048,576 (1 MB) | no |
| Resource policy length (chars) | 8,192 (8 KB) | yes |
| Access log format (bytes) | 3,072 (3 KB) | no |
| Mapping template size (bytes) | 307,200 (300 KB) | no |
| #foreach iterations | 1,000 | no |
| Import file size (bytes) | 6,291,456 (6 MB) | no |
| Payload request/response buffered (bytes) | 10,485,760 (10 MB) | no |
| Header bytes total (REST) | 20,480 (20 KB) | no |
| Header bytes total (HTTP) | 10,240 (10 KB) | no |
| URL length regional (chars) | 10,240 (10 KB) | no |
| URL length edge (chars) | 8,192 (8 KB) | no |
| URL length private (chars) | 8,192 (8 KB) | no |
| Integration timeout REST/WS (ms, raisable to 300s) | 29,000 | yes |
| Integration timeout HTTP (ms) | 30,000 | no |
| Idle client connection keep-alive (s) | 310 | no |
| Cache TTL (s) | 3,600 | no |
| Cached item (bytes) | 1,048,576 (1 MB) | no |
| Streaming duration regional (s) | 900 | no |
| Streaming duration edge (s) | 300 | no |
| Streaming idle (s) | 30 | no |
| WS message (bytes) | 131,072 (128 KB) | no |
| WS frame (bytes) | 32,768 (32 KB) | no |
| WS connection duration (ms) | 7,200,000 | no |
| WS idle (ms) | 600,000 | no |
| WS new connections per second per project | 500 | yes |
| Project throttle (rps) | 10,000 | yes |
| Project throttle (burst) | 5,000 | yes |
| Control plane (rps) | 10 | no |
| Control plane (burst) | 40 | no |

Source: `lib/gateway/core/limits.mjs` (`LIMIT_TABLE`).
