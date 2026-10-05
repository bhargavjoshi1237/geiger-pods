import { route } from "@/lib/control/http.mjs";
import { getSettings, updateSettings } from "@/lib/control/settings.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId }) => getSettings(db, actor, { projectId }),
  { permission: "pods.settings.view" },
);

export const PATCH = route(
  async ({ db, actor, projectId, body, version, requestId }) =>
    updateSettings(db, actor, { projectId, patch: body, expectedVersion: version, requestId }),
  { permission: "pods.settings.write" },
);
