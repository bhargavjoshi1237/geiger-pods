import { route } from "@/lib/control/http.mjs";
import { listRoles } from "@/lib/control/role-grants.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId }) => listRoles(db, actor, { projectId }),
  { permission: "pods.settings.view" },
);
