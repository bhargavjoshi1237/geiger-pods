# Pods global edge layer (S11 Part C, EDGE endpoints)

An API with `endpoint_type = EDGE` (REST only) is served through Pods'
global edge layer instead of a single region's runtime: multi-region
gateway containers behind anycast (or a CDN in front of them), analogous
to AWS edge-optimized endpoints fronted by CloudFront.

## What the gateway implements today (config-level)

- `endpoint_type = EDGE` is accepted on REST APIs (control plane +
  compile) and snapshotted into `artifact.edge.endpointType` on deploy.
- Stream idle timeout is 30 s for EDGE, 5 min otherwise
  (`lib/gateway/core/release/streaming.mjs`).
- Client responses carry `Via: 1.1 pods-edge`
  (`lib/gateway/core/edge/edge-headers.mjs`).

## Infrastructure requirements (not yet provisioned)

- Anycast IPs (or CDN distribution) advertising the edge hostnames, with
  health-checked origins per runtime region (`PODS_REGION`).
- TLS certificates for edge hostnames terminated at the edge, with the
  regional runtimes reachable over the private backbone.
- Cache and WAF policy parity between edge PoPs (shared KV via
  `PODS_KV_URL`; WAF rules already ship in the artifact).
- Production validation of multi-region failover is S15.

## Operations

- Dual-stack: `ip_address_type = dualstack` publishes AAAA records for the
  target hostname; the runtime must bind `::` (`PODS_LISTEN_HOST`, default
  `127.0.0.1` in dev/test). IPv4-only APIs reject IPv6 sources with 403.
- Edge PoP selection and PoP-aware access logs are out of scope until the
  layer is provisioned.
