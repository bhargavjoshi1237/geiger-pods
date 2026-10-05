import { route } from "@/lib/control/http.mjs";
import { rotateSecretService } from "@/lib/control/secrets.mjs";

export const runtime = "nodejs";

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    rotateSecretService(db, actor, {
      projectId,
      secretId: params.secretId,
      value: body?.value,
      requestId,
    }),
  { permission: "pods.secret.write", needsService: true },
);
