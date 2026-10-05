import { route } from "@/lib/control/http.mjs";
import { deleteSubscription } from "@/lib/control/event-subscriptions.mjs";

export const runtime = "nodejs";

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) =>
    deleteSubscription(db, actor, { projectId, subscriptionId: params.subscriptionId, requestId }),
  { permission: "pods.export.write" },
);
