import { route } from "@/lib/control/http.mjs";
import { getTrustStore, updateTrustStore } from "@/lib/control/domains.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    getTrustStore(db, actor, { projectId, truststoreId: params.truststoreId }),
  { permission: "pods.trust_store.write" },
);

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    updateTrustStore(db, actor, { projectId, truststoreId: params.truststoreId, input: body, requestId }),
  { permission: "pods.trust_store.write" },
);
