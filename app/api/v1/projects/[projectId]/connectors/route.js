import { route } from "@/lib/control/http.mjs";
import { createConnector, listConnectors } from "@/lib/control/connectors.mjs";
import { parseTagFilters } from "@/lib/control/tags.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, url }) =>
    listConnectors(db, actor, {
      projectId,
      limit: url.searchParams.get("limit") ?? undefined,
      cursor: url.searchParams.get("cursor"),
      tagFilters: parseTagFilters(url.searchParams),
    }),
  { permission: "pods.connector.write" },
);

export const POST = route(
  async ({ db, actor, projectId, body, requestId }) =>
    createConnector(db, actor, { projectId, input: body, requestId }),
  { permission: "pods.connector.write" },
);
