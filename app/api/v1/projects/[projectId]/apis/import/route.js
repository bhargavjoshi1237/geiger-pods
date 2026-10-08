import { route } from "@/lib/control/http.mjs";
import { importNewApi } from "@/lib/control/openapi-import.mjs";

export const runtime = "nodejs";

export const POST = route(
  async ({ db, actor, projectId, body, url, requestId }) =>
    importNewApi(db, actor, {
      projectId,
      body,
      options: {
        protocol: url.searchParams.get("protocol") ?? undefined,
        basepath: url.searchParams.get("basepath") ?? undefined,
        endpointConfigurationTypes: url.searchParams.get("endpointConfigurationTypes") ?? undefined,
        ignore: url.searchParams.get("ignore") ?? undefined,
        failOnWarnings: url.searchParams.get("failOnWarnings") ?? undefined,
        dryRun: url.searchParams.get("dryRun") ?? undefined,
      },
      requestId,
    }),
  { permission: "pods.api.import" },
);
