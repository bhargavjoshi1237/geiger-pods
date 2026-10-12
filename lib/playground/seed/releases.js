// Releases: immutable deployments per API, the stages that serve them and
// each stage's pointer history. Rows mirror supabase/migrations/releases.
// Deployments grow the API over time (later snapshots carry more routes), so
// diffs between them read like a real release history.

import { PROJECT_ID, between, daysAgo, pick, sid } from "./helpers.js";
import { personId } from "../cast.js";
import { API_SPECS, apiId, operations } from "./catalog.js";

const DEPLOY_NOTES = [
  "Initial release", "Add reviews endpoints", "Tighten CORS for the launch site", "Raise checkout timeout",
  "Dealer authorizer v2", "Cache product reads", "Pagination on list endpoints", "Rollback-safe schema change",
  "Return 404 for unknown routes", "Rotate backend certificate", "Holiday traffic tuning", "Hotfix: cart totals",
];

const DEPLOYERS = [9, 5, 2, 9, 3];

/** Deployment count per API (newer, smaller APIs have fewer releases). */
function deployCount(spec) {
  return Math.max(2, Math.min(9, Math.round(spec.created / 40)));
}

function digestFor(n) {
  let hex = "";
  for (let i = 0; i < 8; i += 1) hex += between(n * 13 + i, 0x10000000, 0xffffffff).toString(16).padStart(8, "0");
  return `sha256:${hex}`;
}

/** Every seeded stage in seed order: { n, apiN, name, production } (stage n is sid("stage", n)). */
export const STAGE_REFS = API_SPECS.flatMap((spec) => spec.stages.map((name, index) => ({ apiN: spec.n, name, production: index === 0 })))
  .map((ref, index) => ({ n: index + 1, ...ref }));

export function releasesSeed() {
  const deployments = [];
  const stages = [];
  const stage_history = [];
  const ops = operations();
  let deploymentN = 0;
  let stageN = 0;
  let historyN = 0;

  for (const spec of API_SPECS) {
    const count = deployCount(spec);
    const apiOps = ops.filter((op) => op.spec.n === spec.n);
    const mine = [];
    for (let k = 1; k <= count; k += 1) {
      deploymentN += 1;
      const age = Math.round(spec.created - ((spec.created - 1) * (k - 1)) / Math.max(1, count - 1));
      const included = apiOps.slice(0, Math.max(1, Math.ceil((apiOps.length * k) / count)));
      const row = {
        id: sid("deployment", deploymentN),
        project_id: PROJECT_ID,
        api_id: apiId(spec.n),
        public_id: `dp${spec.n}${String(k).padStart(2, "0")}${spec.publicId.slice(0, 4)}`,
        description: k === 1 ? "Initial release" : pick(DEPLOY_NOTES.slice(1), deploymentN),
        artifact: {
          schemaVersion: 1,
          api: { publicId: spec.publicId, protocol: spec.protocol, name: spec.name, endpointType: spec.endpointType },
          routes: included.map((op) => ({
            key: op.key,
            integration: { id: sid("integration", op.n), timeoutMs: spec.n === 9 ? 10000 : 29000 },
            auth: op.method === "GET" ? "NONE" : "API_KEY",
          })),
          settings: { throttle: { rateLimit: 500 + k * 50, burstLimit: 1000 }, cache: spec.traffic?.cache ? { ttl: k > count / 2 ? 300 : 60 } : null },
        },
        digest: digestFor(deploymentN),
        schema_version: 1,
        warnings: k === count && spec.n === 9 ? [{ code: "integration_timeout_high", message: "POST /webhooks/shopify waits up to 10 s for its function." }] : [],
        created_by: personId(DEPLOYERS[(deploymentN + k) % DEPLOYERS.length]),
        created_at: daysAgo(age, (k * 5) % 11),
      };
      deployments.push(row);
      mine.push(row);
    }

    spec.stages.forEach((name, index) => {
      stageN += 1;
      const production = index === 0;
      // prod serves the latest deployment except where a rollback is in progress.
      const served = production ? mine[mine.length - (spec.n === 6 ? 2 : 1)] : mine[mine.length - 1];
      const stage = {
        id: sid("stage", stageN),
        project_id: PROJECT_ID,
        api_id: apiId(spec.n),
        name,
        deployment_id: served.id,
        description: production ? `Live traffic for ${spec.name}.` : "Pre-release checks and client UAT.",
        variables: production
          ? { backendHost: new URL(spec.backend).host, logLevel: "warn" }
          : { backendHost: new URL(spec.backend).host.replace(/^[^.]+/, (sub) => `${sub}-staging`), logLevel: "debug" },
        auto_deploy: spec.protocol === "HTTP" && !production,
        client_certificate_id: spec.n === 6 && production ? sid("client_certificate", 1) : null,
        default_route_settings: spec.protocol === "REST"
          ? {}
          : { throttlingRateLimit: production ? 1000 : 50, throttlingBurstLimit: production ? 2000 : 100, detailedMetricsEnabled: production },
        route_settings: {},
        method_settings: spec.protocol === "REST"
          ? { "*/*": { metricsEnabled: true, loggingLevel: production ? "ERROR" : "INFO", throttlingRateLimit: production ? 1000 : 50, throttlingBurstLimit: production ? 2000 : 100, cachingEnabled: Boolean(spec.traffic?.cache) && production, cacheTtlInSeconds: 300 } }
          : {},
        access_log: production
          ? { destination: "pods://logs", format: "$context.requestId $context.identity.sourceIp $context.httpMethod $context.resourcePath $context.status $context.responseLatency" }
          : null,
        tracing_enabled: production && spec.protocol === "REST",
        cache_cluster_enabled: production && Boolean(spec.traffic?.cache),
        cache_cluster_size: production && spec.traffic?.cache ? (spec.n === 1 ? "6.1" : "1.6") : null,
        cache_default_ttl: 300,
        cache_data_encrypted: spec.n === 7,
        require_authorization_for_cache_control: true,
        unauthorized_cache_control_header_strategy: "SUCCEED_WITH_RESPONSE_HEADER",
        canary: spec.n === 1 && production
          ? { percentTraffic: 10, deploymentId: mine[mine.length - 1].id, stageVariableOverrides: { logLevel: "info" }, useStageCache: false }
          : null,
        last_deployment_status_message: spec.n === 6 && production ? "Rolled back to the previous deployment after elevated 5XX on /reservations." : null,
        documentation_version: spec.protocol === "REST" && production ? "1.0" : null,
        default_logging_level: production ? "ERROR" : "INFO",
        default_data_trace: !production,
        tags: { env: production ? "production" : name },
        created_by: personId(spec.owner),
        created_at: mine[0].created_at,
        updated_at: served.created_at,
        version: 1 + mine.length,
      };
      stages.push(stage);

      // Pointer history: every deployment for non-prod; prod skips a few and
      // records the Solace rollback.
      let previous = null;
      mine.forEach((deployment, k) => {
        if (production && k % 2 === 1 && k !== mine.length - 1) return;
        historyN += 1;
        stage_history.push({
          id: sid("stage_history", historyN),
          project_id: PROJECT_ID,
          stage_id: stage.id,
          from_deployment_id: previous?.id ?? null,
          to_deployment_id: deployment.id,
          reason: !production && spec.protocol === "HTTP" ? "auto_deploy" : "deploy",
          actor_id: deployment.created_by,
          created_at: deployment.created_at,
        });
        previous = deployment;
      });
      if (production && served.id !== previous?.id) {
        historyN += 1;
        stage_history.push({
          id: sid("stage_history", historyN),
          project_id: PROJECT_ID,
          stage_id: stage.id,
          from_deployment_id: previous?.id ?? null,
          to_deployment_id: served.id,
          reason: "rollback",
          actor_id: personId(4),
          created_at: daysAgo(1, 6),
        });
      }
    });
  }

  return { deployments, stages, stage_history };
}
