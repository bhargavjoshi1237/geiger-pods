import { route } from "@/lib/control/http.mjs";
import { deleteClientCertificate, getClientCertificate } from "@/lib/control/client-certificates.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId, params }) =>
    getClientCertificate(db, actor, { projectId, certificateId: params.certificateId }),
  { permission: "pods.client_cert.write" },
);

export const DELETE = route(
  async ({ db, actor, projectId, params, requestId }) =>
    deleteClientCertificate(db, actor, { projectId, certificateId: params.certificateId, requestId }),
  { permission: "pods.client_cert.write" },
);
