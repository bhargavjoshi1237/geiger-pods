import { route } from "@/lib/control/http.mjs";
import { deleteConnector, getConnector, updateConnector } from "@/lib/control/connectors.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    getConnector(db, actor, { projectId, connectorId: params.connectorId }),
  { permission: "pods.connector.write" },
);

export const PATCH = route(
  async ({ db, actor, projectId, params, body, version, requestId }) =>
    updateConnector(db, actor, {
      projectId,
      connectorId: params.connectorId,
      patch: body,
      expectedVersion: version,
      requestId,
    }),
  { permission: "pods.connector.write" },
);

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) =>
    deleteConnector(db, actor, { projectId, connectorId: params.connectorId, requestId }),
  { permission: "pods.connector.write" },
);
