# AniList showcase seed

Seeds the **Geiger Notes** project's Pods workspace with a working showcase
built on the free [AniList GraphQL API](https://docs.anilist.co). It runs as
`bhargavjoshi1237@gmail.com`, the project owner, and calls the same
control-plane services the management API uses. Every step finds existing
rows by name, so re-running is safe.

```bash
node scripts/seed-anilist/index.mjs                 # everything
node scripts/seed-anilist/index.mjs --only logs     # one or more steps (comma-separated)
node scripts/seed-anilist/verify.mjs                # read every screen's data path
node scripts/seed-anilist/gateway-local.mjs         # data plane on :4000
node scripts/seed-anilist/traffic.mjs               # 37 live scenarios through the gateway
```

The steps run in order:

| Step | What it creates |
| --- | --- |
| `foundation` | Project settings, 7 vault secrets, team roles for the `@geiger.studio` personas |
| `connectors` | Two Pods Connectors with agent tokens, a backend client certificate, the `partner-ca-bundle` trust store |
| `rest` | **AniList Explorer** (REST): 18 resources, 22 methods, 5 models, 2 validators, 2 authorizers, 12 branded gateway responses, CORS, a resource policy and deployments v1.0 to v1.3 |
| `http` | **AniList GraphQL Edge** (HTTP API): GraphQL proxy, a JWT-protected viewer route, a greedy site pass-through and CORS |
| `ws` | **AniList Live** (WebSocket): `$connect`, `$disconnect`, `$default`, `ping` and two-way `graphql` |
| `releases` | Stages `dev`, `staging` and `prod`, with a 10% v1.3 canary on prod; the prod stage cache, throttles, access logs, tracing, agent tools (MCP) and documentation |
| `domains` | `anime.geiger-notes.dev` (mappings `/v1`, `/v1-preview`, `/graphql`, plus routing rules), `partners.` (mTLS) and `live.` (pending DNS) |
| `usage` | Plans **Genin · Free**, **Chunin · Pro**, **Hokage · Partner** and **Internal QA**; 10 keys, including a CSV import, a rotation, a disabled key and a quota top-up |
| `security` | Web ACLs `anilist-edge-shield` and `staging-office-only`; 2 signing credentials with policies |
| `monitoring` | 3 notification channels, 7 alarms, 3 log export sinks, trace sampling |
| `portal` | **AniList Developer Hub** at `/portal/anilist-hub`: 3 products with guide pages and try-it endpoints |
| `admin` | Access tokens, 3 event webhooks, the `anilist-sandbox` stack, tags |
| `data` | 30 days of metrics, per-key usage, alarm history, portal analytics, webhook deliveries, connector heartbeats and a backdated release timeline |
| `logs` | 3 days of access logs, execution logs and traces (needs the `20261021000001` migration) |

One-time secrets go to `output/`, which is git-ignored:
- API key values: `api-keys.json`
- Access tokens: `access-tokens.json`
- Seed state: `state.json`

## The story the data tells

- **Season premiere:** the Fall 2026 premiere 8 to 12 days ago lifts traffic by about 70%.
- **AniList incident:** a 3-hour incident 4 days ago (14:00 to 17:00 UTC) trips *Explorer prod 5XX* and *GraphQL Edge 5xx*, which recover afterwards.
- **Canary:** v1.3 has been on a 10% prod canary since yesterday.
- **Quota pressure:** free-tier keys brush their 500-a-day quota, so *Quota rejections* is firing now. *Otaku Tracker iOS* sits near its Pro monthly quota.
- **Upstream limit:** AniList allows only 30 requests a minute per client. The prod stage cache (300 s) and the throttles are what keep the pod under it.

## Demo walkthrough

1. **Overview:** 14-day traffic with the premiere bump and the incident, the per-API breakdown, and the firing alarm.
2. **APIs → AniList Explorer → Resources:** open `GET /anime/{id}`. The integration POSTs a GraphQL query built by a VTL request template. The response template flattens AniList's `data.Media`, and integration responses map 404, 429 and 5xx to branded errors.
3. **Test tab:** invoke `GET /anime/154587` (Frieren) against the draft.
4. **Deployments:** diff v1.2 against v1.3, which adds `/anime/{id}/streaming`. The draft is ahead of v1.3 (null-safe list templates), so deploy it live.
5. **Stages → prod:** show the canary at 10%, then **Promote**. This works as a signed-in owner; the seed couldn't do it with the service role. Also show the cache, throttles, logging and agent tools.
6. **Usage plans / API keys:** the free/pro/partner tiers, the rotated *Seasonal Chart Web* key and the disabled hackathon key.
7. **Security:**
   - **Secrets:** the injected `X-Geiger-Client` header (v2 after rotation).
   - **WAF:** managed rule groups, the scraper IP and user-agent rules, and the per-IP rate limit.
   - **Signing credentials:** the two credentials and their policies.
8. **Networking:** the custom domains with mappings and routing rules, the mTLS partner domain, and the connectors (one degraded).
9. **Monitoring:** the dashboard, the logs and request detail (after the `logs` step), alarm history, and log exports.
10. **Portals:** open `/portal/anilist-hub`.
11. **Settings:** team roles, access tokens, stacks and the audit log.

### Live calls

Start the gateway and send the custom domain as the `Host` header. The managed WAF rules block `Host: localhost`, so the domain header is also what lets local calls through.

```bash
KEY=$(node -p "require('./scripts/seed-anilist/output/api-keys.json')['Demo Presenter'].value")
curl -H "Host: anime.geiger-notes.dev" -H "x-api-key: $KEY" http://127.0.0.1:4000/v1/anime/154587
curl -H "Host: anime.geiger-notes.dev" -H "x-api-key: $KEY" "http://127.0.0.1:4000/v1/anime/search?q=Frieren"
curl -H "Host: anime.geiger-notes.dev" http://127.0.0.1:4000/v1/anime/21     # 403 INVALID_API_KEY (branded)
curl -H "Host: anime.geiger-notes.dev" -H "user-agent: python-requests/2.31" -H "x-api-key: $KEY" \
     http://127.0.0.1:4000/v1/anime/21                                       # 403 blocked by the WAF
```

## Notes

- **Environment variables:** the app and the gateway need the same `PODS_VAULT_KEYS`, `PODS_VAULT_ACTIVE_KID` and `PODS_KEY_PEPPER` values as `.env`. Add them to the Vercel project, or the deployed UI can't read the seeded secrets and gateway key checks fail.
- **Auth-guarded steps:** stage pointer moves and the `grant_role` RPC authorize through `auth.uid()`. The seed therefore creates each stage on its final deployment and backdates the release history. Promoting the canary is left for a signed-in user.
- **Demo placeholders:** the secret values, webhook URLs, partner authorizer endpoint and on-prem recommendation engine are placeholders. `/anime/{id}/similar` (connector) and `/partners/exports` (webhook authorizer) fail when called for real.
