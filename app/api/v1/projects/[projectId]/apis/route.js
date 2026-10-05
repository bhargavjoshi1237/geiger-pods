import { route } from "@/lib/control/http.mjs";
import { createApi, listApis } from "@/lib/control/apis.mjs";
import { parseTagFilters } from "@/lib/control/tags.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, url }) =>
    listApis(db, actor, {
      projectId,
      limit: url.searchParams.get("limit") ?? undefined,
      cursor: url.searchParams.get("cursor"),
      tagFilters: parseTagFilters(url.searchParams),
    }),
);

export const POST = route(
  async ({ db, actor, projectId, body, requestId }) =>
    createApi(db, actor, { projectId, requestId, ...(body ?? {}) }),
);
