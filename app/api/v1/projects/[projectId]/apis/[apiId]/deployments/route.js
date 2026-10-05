import { route } from "@/lib/control/http.mjs";
import { createDeployment, listDeployments } from "@/lib/control/deployments.mjs";
import { scheduleAutoDeploy } from "@/lib/control/deployments.mjs";
import { after } from "next/server";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params, url }) =>
    listDeployments(db, actor, {
      projectId,
      apiId: params.apiId,
      limit: url.searchParams.get("limit") ?? undefined,
      cursor: url.searchParams.get("cursor"),
    }),
);

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) => {
    const result = await createDeployment(db, actor, {
      projectId,
      apiId: params.apiId,
      description: body?.description ?? "",
      stageName: body?.stageName ?? null,
      stageDescription: body?.stageDescription ?? "",
      requestId,
    });
    // Auto-deploy bookkeeping runs after the response (no-op unless stages
    // request it; kept here so draft mutations stay fast).
    try {
      after(() => scheduleAutoDeploy(db, { projectId, apiId: params.apiId, actor }).catch?.(() => {}));
    } catch {
      // `after()` is only available in the Next runtime; tests call directly.
    }
    return result;
  },
  { permission: "pods.deployment.create" },
);
