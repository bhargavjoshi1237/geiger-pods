// Playground fake for the v1 API: Connectors and connector tokens.
// After app/api/v1/projects/[projectId]/connectors/** and lib/control/connectors.mjs.

import { byOldest, fail, live, page, routes, table } from "./http.js";

// Copy of lib/control/connectors.mjs connectorView().
function toConnectorView(row) {
  return {
    id: row.id, projectId: row.project_id, name: row.name, status: row.status, statusMessage: row.status_message ?? null,
    allowedTargets: row.allowed_targets ?? [], agentCount: row.agent_count ?? 0, lastSeenAt: row.last_seen_at ?? null,
    description: row.description ?? null, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

// Copy of lib/control/connectors.mjs tokenView().
function toTokenView(row) {
  return { id: row.id, connectorId: row.connector_id, prefix: row.prefix, createdAt: row.created_at, revokedAt: row.revoked_at ?? null };
}

function findConnector(connectorId) {
  const row = live("connectors", (connector) => connector.id === connectorId)[0];
  if (!row) fail(404, "not_found", "Connector does not exist.");
  return row;
}

function listConnectors({ query }) {
  const result = page(live("connectors").sort(byOldest), query);
  return { items: result.items.map(toConnectorView), nextCursor: result.nextCursor };
}

function listTokens({ params }) {
  const connector = findConnector(params.connectorId);
  return { items: table("connector_tokens").filter((row) => row.connector_id === connector.id).sort(byOldest).map(toTokenView) };
}

export const connectorsRoutes = routes([
  ["GET", "/connectors", listConnectors],
  ["GET", "/connectors/:connectorId", ({ params }) => toConnectorView(findConnector(params.connectorId))],
  ["GET", "/connectors/:connectorId/tokens", listTokens],
]);
