import { route } from "@/lib/control/http.mjs";
import { exportStage } from "@/lib/control/openapi-export.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params, url, requestId }) =>
    exportStage(db, actor, {
      projectId,
      apiId: params.apiId,
      stageName: params.stageName,
      query: {
        type: url.searchParams.get("type") ?? undefined,
        format: url.searchParams.get("format") ?? undefined,
        extensions: url.searchParams.get("extensions") ?? undefined,
        includeDocs: url.searchParams.get("includeDocs") ?? undefined,
        domain: url.searchParams.get("domain") ?? undefined,
      },
      requestId,
    }),
  { permission: "pods.api.export" },
);
