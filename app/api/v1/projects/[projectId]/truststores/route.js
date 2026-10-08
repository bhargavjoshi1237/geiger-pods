import { route } from "@/lib/control/http.mjs";
import { createTrustStore, listTrustStores } from "@/lib/control/domains.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId }) => listTrustStores(db, actor, { projectId }),
  { permission: "pods.trust_store.write" },
);

export const POST = route(
  async ({ db, actor, projectId, body, requestId }) =>
    createTrustStore(db, actor, { projectId, input: body, requestId }),
  { permission: "pods.trust_store.write" },
);
