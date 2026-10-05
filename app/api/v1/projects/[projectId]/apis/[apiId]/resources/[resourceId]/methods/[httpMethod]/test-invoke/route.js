import { route } from "@/lib/control/http.mjs";
import { testInvoke } from "@/lib/control/test-invoke.mjs";

export const runtime = "nodejs";

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) =>
    testInvoke(db, actor, {
      projectId,
      apiId: params.apiId,
      resourceId: params.resourceId,
      httpMethod: params.httpMethod,
      pathWithQueryString: body?.pathWithQueryString ?? "/",
      headers: body?.headers ?? {},
      body: body?.body ?? null,
      stageVariables: body?.stageVariables ?? {},
      clientCertificateId: body?.clientCertificateId ?? null,
      requestId,
    }),
  { permission: "pods.test.invoke" },
);
