import { route } from "@/lib/control/http.mjs";
import { createToken, listTokens } from "@/lib/control/access-tokens.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId }) => listTokens(db, actor, { projectId }),
  { permission: "pods.token.write" },
);

export const POST = route(
  async ({ db, actor, projectId, body, requestId }) =>
    createToken(db, actor, {
      projectId,
      kind: body?.kind,
      name: body?.name,
      scopes: body?.scopes,
      expiresAt: body?.expiresAt ?? null,
      userId: body?.userId ?? null,
      requestId,
    }),
  { permission: "pods.token.write" },
);
