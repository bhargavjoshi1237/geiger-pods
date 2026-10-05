import { route } from "@/lib/control/http.mjs";
import { generateClientCertificate, listClientCertificates } from "@/lib/control/client-certificates.mjs";

export const runtime = "nodejs";

export const GET = route(
  async ({ db, actor, projectId }) => listClientCertificates(db, actor, { projectId }),
  { permission: "pods.client_cert.write" },
);

// Generation seals the private key through the service-role vault path.
export const POST = route(
  async ({ db, actor, projectId, body, requestId }) =>
    generateClientCertificate(db, actor, { projectId, input: body, requestId }),
  { permission: "pods.client_cert.write", needsService: true },
);
