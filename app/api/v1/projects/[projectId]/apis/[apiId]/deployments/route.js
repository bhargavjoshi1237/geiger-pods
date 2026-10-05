import { route } from "@/lib/control/http.mjs";
import { createDeployment, listDeployments } from "@/lib/control/deployments.mjs";
import { deployToCanary } from "@/lib/control/canary.mjs";
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
    // S09: deploy-to-canary (AWS CreateDeployment with canarySettings).
    if (body?.canary !== undefined && body?.canary !== null) {
      return deployToCanary(db, actor, {
        projectId,
        apiId: params.apiId,
        stageName: body?.stageName,
        description: body?.description ?? "",
        percentTraffic: body?.canary?.percentTraffic ?? 10,
        stageVariableOverrides: body?.canary?.stageVariableOverrides ?? {},
        useStageCache: body?.canary?.useStageCache ?? false,
        requestId,
      });
    }
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
