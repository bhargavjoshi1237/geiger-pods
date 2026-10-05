import { HttpError } from "@/lib/control/errors.mjs";
import { route } from "@/lib/control/http.mjs";
import { deleteSecretService, getSecret, updateSecret } from "@/lib/control/secrets.mjs";

export const runtime = "nodejs";

const OPTIONS = { permission: "pods.secret.write" };

export const GET = route(
  async ({ db, actor, projectId, params }) => getSecret(db, actor, { projectId, secretId: params.secretId }),
  OPTIONS,
);

export const PATCH = route(
  async ({ db, actor, projectId, params, body, version, requestId }) => {
    if (body !== null && (typeof body !== "object" || Array.isArray(body))) {
      throw new HttpError(422, "invalid_input", "Request body must be a JSON object.");
    }
    return updateSecret(db, actor, {
      projectId,
      secretId: params.secretId,
      patch: body,
      expectedVersion: version,
      requestId,
    });
  },
  OPTIONS,
);

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) =>
    deleteSecretService(db, actor, { projectId, secretId: params.secretId, requestId }),
  OPTIONS,
);
