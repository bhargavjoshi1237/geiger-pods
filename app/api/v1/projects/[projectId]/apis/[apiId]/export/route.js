import { route } from "@/lib/control/http.mjs";
import { exportDraft } from "@/lib/control/openapi-export.mjs";

export const runtime = "nodejs";

// Draft export (Pods extension): `?source=draft` compiles the draft
// without deploying. Only `draft` is supported today.
export const GET = route(
  async ({ db, actor, projectId, params, url, requestId }) =>
    exportDraft(db, actor, {
      projectId,
      apiId: params.apiId,
      query: {
        type: url.searchParams.get("type") ?? undefined,
        format: url.searchParams.get("format") ?? undefined,
        extensions: url.searchParams.get("extensions") ?? undefined,
        includeDocs: url.searchParams.get("includeDocs") ?? undefined,
      },
      requestId,
    }),
  { permission: "pods.api.export" },
);
