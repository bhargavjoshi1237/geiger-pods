import { route } from "@/lib/control/http.mjs";
import { createSubscription, listSubscriptions } from "@/lib/control/event-subscriptions.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId }) => listSubscriptions(db, actor, { projectId }),
  { permission: "pods.export.write" },
);

export const POST = route(
  async ({ db, actor, projectId, body, requestId }) =>
    createSubscription(db, actor, { projectId, input: body, requestId }),
  { permission: "pods.export.write" },
);
