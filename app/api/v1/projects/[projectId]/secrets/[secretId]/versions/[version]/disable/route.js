import { HttpError } from "@/lib/control/errors.mjs";
import { route } from "@/lib/control/http.mjs";
import { disableSecretVersion } from "@/lib/control/secrets.mjs";

export const runtime = "nodejs";

export const POST = route(
  async ({ db, actor, projectId, params, requestId }) => {
    const version = Number(params.version);
    if (!Number.isInteger(version) || version < 1) {
      throw new HttpError(422, "invalid_input", "Version must be a positive integer.");
    }
    return disableSecretVersion(db, actor, { projectId, secretId: params.secretId, version, requestId });
  },
  { permission: "pods.secret.write", needsService: true },
);
