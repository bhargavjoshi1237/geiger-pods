import { route } from "@/lib/control/http.mjs";
import { importCertificate, issueManagedCertificate } from "@/lib/control/domains.mjs";

export const runtime = "nodejs";

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) => {
    if (body?.mode === "managed" || !body?.chainPem) {
      return issueManagedCertificate(db, actor, { projectId, domainId: params.domainId, requestId });
    }
    return importCertificate(db, actor, {
      projectId,
      domainId: params.domainId,
      chainPem: body.chainPem,
      keyPem: body.keyPem,
      domainName: body.domainName ?? null,
      requestId,
    });
  },
  { permission: "pods.domain.write" },
);
