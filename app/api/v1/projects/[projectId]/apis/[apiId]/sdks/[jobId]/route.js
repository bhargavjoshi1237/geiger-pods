import { resolveActor } from "@/lib/control/actor.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { downloadSdk } from "@/lib/control/sdks.mjs";
import { newRequestId, errorResponse } from "@/lib/control/http.mjs";

export const runtime = "nodejs";

// Zip downloads cannot go through the JSON `route()` wrapper (same pattern
// as the audit CSV export): manual auth flow, raw `application/zip`.
export async function GET(request, routeContext = {}) {
  const requestId = newRequestId();
  try {
    const params = (await routeContext?.params) ?? {};
    const projectId = params.projectId ?? null;
    const { createServerSupabase } = await import("@/lib/supabase/server.js");
    const supabase = await createServerSupabase();
    const actor = await resolveActor(request, { supabase });
    const db = createControlDb(supabase, {});
    const { zip, job } = await downloadSdk(db, actor, {
      projectId,
      apiId: params.apiId,
      jobId: params.jobId,
    });
    return new Response(zip, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${job.language}-sdk-${job.id.slice(0, 8)}.zip"`,
        "x-pods-request-id": requestId,
      },
    });
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
