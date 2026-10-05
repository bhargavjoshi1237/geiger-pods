import { route } from "@/lib/control/http.mjs";
import { revokeConnectorToken, rotateConnectorToken } from "@/lib/control/connectors.mjs";

export const runtime = "nodejs";

// DELETE revokes. POST with `{ "action": "rotate" }` revokes and issues a
// replacement (still shown once).
export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) =>
    revokeConnectorToken(db, actor, {
      projectId,
      connectorId: params.connectorId,
      tokenId: params.tokenId,
      requestId,
    }),
  { permission: "pods.connector.write", needsService: true },
);

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) => {
    if (body?.action !== "rotate") {
      const { HttpError } = await import("@/lib/control/errors.mjs");
      throw new HttpError(422, "invalid_input", "POST expects { \"action\": \"rotate\" }; DELETE revokes.");
    }
    return rotateConnectorToken(db, actor, {
      projectId,
      connectorId: params.connectorId,
      tokenId: params.tokenId,
      requestId,
    });
  },
  { permission: "pods.connector.write", needsService: true },
);
