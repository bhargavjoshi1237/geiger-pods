import { route } from "@/lib/control/http.mjs";
import { createConnectorToken, listConnectorTokens } from "@/lib/control/connectors.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    listConnectorTokens(db, actor, { projectId, connectorId: params.connectorId }),
  { permission: "pods.connector.write" },
);

// Token creation writes the hash through the service-role path (no
// authenticated insert policy by design) and returns the plaintext once.
export const POST = route(
  async ({ db, actor, projectId, params, requestId }) =>
    createConnectorToken(db, actor, { projectId, connectorId: params.connectorId, requestId }),
  { permission: "pods.connector.write", needsService: true },
);
