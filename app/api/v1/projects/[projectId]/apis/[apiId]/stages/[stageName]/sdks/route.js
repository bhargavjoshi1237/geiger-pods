import { route } from "@/lib/control/http.mjs";
import { generateSdk } from "@/lib/control/sdks.mjs";

export const runtime = "nodejs";

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    generateSdk(db, actor, {
      projectId,
      apiId: params.apiId,
      stageName: params.stageName,
      language: body?.language,
      config: body?.config ?? {},
      requestId,
    }),
  { permission: "pods.sdk.generate" },
);
