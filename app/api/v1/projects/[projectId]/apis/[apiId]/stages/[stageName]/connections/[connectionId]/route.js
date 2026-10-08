import { route } from "@/lib/control/http.mjs";
import { manageConnection } from "@/lib/control/websocket.mjs";

export const runtime = "nodejs";

async function readBodyBuffer(request) {
  try {
    const buffer = Buffer.from(await request.arrayBuffer());
    return buffer.byteLength > 0 ? buffer : null;
  } catch {
    return null;
  }
}

// F38: control → runtime URL for prod UI/CLI. When `PODS_GATEWAY_URL` (plus a
// service credential with `execute-api:ManageConnections`) is configured the
// mirror forwards to the live gateway; otherwise it preserves the 410 so
// callers can distinguish "no runtime wired" from gateway errors. The service
// credential is provisioned out of band (vault `gateway-connections` secret;
// see docs/ops/restore.md) — auto-provisioning is the noted gap.
function gatewayConfig() {
  const gatewayUrl = process.env.PODS_GATEWAY_URL ?? "";
  const accessKeyId = process.env.PODS_GATEWAY_CONNECTIONS_KEY ?? "";
  const secretAccessKey = process.env.PODS_GATEWAY_CONNECTIONS_SECRET ?? "";
  if (!gatewayUrl || !accessKeyId || !secretAccessKey) return null;
  return { gatewayUrl, accessKeyId, secretAccessKey };
}

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    manageConnection(db, actor, {
      projectId,
      apiId: params.apiId,
      stage: params.stageName,
      connectionId: params.connectionId,
      method: "GET",
      gateway: gatewayConfig(),
    }),
  { permission: "pods.connection.manage" },
);

export const POST = route(
  async ({ db, actor, projectId, params, request }) =>
    manageConnection(db, actor, {
      projectId,
      apiId: params.apiId,
      stage: params.stageName,
      connectionId: params.connectionId,
      method: "POST",
      body: await readBodyBuffer(request),
      contentType: request.headers.get("content-type") ?? "application/json",
      gateway: gatewayConfig(),
    }),
  { permission: "pods.connection.manage" },
);

export const DELETE = route(
  async ({ db, actor, projectId, params }) =>
    manageConnection(db, actor, {
      projectId,
      apiId: params.apiId,
      stage: params.stageName,
      connectionId: params.connectionId,
      method: "DELETE",
      gateway: gatewayConfig(),
    }),
  { permission: "pods.connection.manage" },
);
