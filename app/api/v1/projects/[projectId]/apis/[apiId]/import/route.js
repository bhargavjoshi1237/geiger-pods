import { route } from "@/lib/control/http.mjs";
import { importExistingApi } from "@/lib/control/openapi-import.mjs";

export const runtime = "nodejs";

export const PUT = route(
  async ({ db, actor, projectId, params, body, url, requestId }) =>
    importExistingApi(db, actor, {
      projectId,
      apiId: params.apiId,
      body,
      options: {
        mode: url.searchParams.get("mode") ?? undefined,
        basepath: url.searchParams.get("basepath") ?? undefined,
        ignore: url.searchParams.get("ignore") ?? undefined,
        failOnWarnings: url.searchParams.get("failOnWarnings") ?? undefined,
        dryRun: url.searchParams.get("dryRun") ?? undefined,
      },
      requestId,
    }),
  { permission: "pods.api.import" },
);
