import { route } from "@/lib/control/http.mjs";
import { applyStack, driftStack, planStack } from "@/lib/control/stacks.mjs";

export const runtime = "nodejs";

export const POST = route(
  async ({ db, actor, projectId, params, body, url }) => {
    const file = body?.file ?? body;
    const prune = url.searchParams.get("prune") === "true" || body?.prune === true;
    if (params.action === "plan") {
      const planned = await planStack(db, actor, { projectId, stack: params.stack, file, prune });
      return { status: 200, body: planned };
    }
    if (params.action === "apply") {
      const result = await applyStack(db, actor, { projectId, stack: params.stack, file, prune });
      return { status: 200, body: result };
    }
    if (params.action === "drift") {
      const drifted = await driftStack(db, actor, { projectId, stack: params.stack, file });
      return { status: 200, body: drifted };
    }
    const { HttpError } = await import("@/lib/control/errors.mjs");
    throw new HttpError(404, "not_found", `Unknown stacks action "${params.action}". Use plan, apply or drift.`);
  },
  { permission: "pods.api.create" },
);
