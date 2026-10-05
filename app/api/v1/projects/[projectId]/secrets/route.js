import { route } from "@/lib/control/http.mjs";
import { createSecretService, listSecrets } from "@/lib/control/secrets.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, url }) =>
    listSecrets(db, actor, {
      projectId,
      limit: url.searchParams.get("limit") ?? undefined,
      cursor: url.searchParams.get("cursor"),
    }),
  { permission: "pods.secret.write" },
);

export const POST = route(
  async ({ db, actor, projectId, body, requestId }) =>
    createSecretService(db, actor, {
      projectId,
      name: body?.name,
      kind: body?.kind,
      value: body?.value,
      description: body?.description,
      expiresAt: body?.expiresAt,
      requestId,
    }),
  { permission: "pods.secret.write", needsService: true },
);
