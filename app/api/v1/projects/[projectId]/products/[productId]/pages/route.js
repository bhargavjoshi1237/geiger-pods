import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withPortalTables } from "@/lib/control/portal-db.mjs";
import { createProductEndpoint, createProductPage } from "@/lib/control/portals.mjs";

export const runtime = "nodejs";

const deps = {
  createControlDb: (client, options) => withPortalTables(createControlDb(client, options), client),
};

export const POST = route(
  async ({ db, actor, projectId, params, body, requestId }) => {
    if (body?.kind === "endpoint") {
      return createProductEndpoint(db, actor, {
        projectId,
        productId: params.productId,
        apiId: body?.apiId,
        stageName: body?.stageName,
        resourcePath: body?.resourcePath,
        httpMethod: body?.httpMethod,
        operationName: body?.operationName ?? "",
        displayOverrideMarkdown: body?.displayOverrideMarkdown ?? null,
        tryItEnabled: body?.tryItEnabled ?? true,
        requestId,
      });
    }
    return createProductPage(db, actor, {
      projectId,
      productId: params.productId,
      title: body?.title,
      slug: body?.slug,
      bodyMarkdown: body?.bodyMarkdown ?? "",
      order: body?.order ?? 0,
      requestId,
    });
  },
  { permission: "pods.portal.write", deps },
);
