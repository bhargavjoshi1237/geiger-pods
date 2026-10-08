import { route } from "@/lib/control/http.mjs";
import { listSampledRequests } from "@/lib/control/waf.mjs";
import { getControlKv } from "@/lib/control/rate-limit.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params, url }) => {
    const query = url.searchParams;
    // The gateway and the control plane share one KV store (ADR-4): with
    // `PODS_KV_URL` set this reads the same Redis the runtime samples into.
    // Without it each process has its own memory store, so dev gateways
    // show an empty list here (kvAvailable stays true).
    const kv = await getControlKv().catch(() => null);
    return listSampledRequests(db, actor, {
      projectId,
      aclId: params.aclId,
      stage: query.get("stage"),
      rule: query.get("rule"),
      limit: query.get("limit") ?? undefined,
      kv,
    });
  },
  { permission: "pods.waf.write" },
);
