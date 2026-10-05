import { route } from "@/lib/control/http.mjs";
import { createControlDb } from "@/lib/control/supabase-db.mjs";
import { withObservabilityTables } from "@/lib/control/observe-db.mjs";
import { queryMetrics, queryOverviewCounts } from "@/lib/control/metrics.mjs";

export const runtime = "nodejs";

const deps = { createControlDb: (client, opts) => withObservabilityTables(createControlDb(client, opts), client) };

function parseDims(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(String(value));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to comma-separated key=value pairs.
  }
  const out = {};
  for (const part of String(value).split(",")) {
    const separator = part.indexOf("=");
    if (separator > 0) out[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
  }
  return out;
}

export const GET = route(
  async ({ db, actor, projectId, url }) => {
    const query = url.searchParams;
    if (query.get("view") === "overview") {
      return queryOverviewCounts(db, actor, {
        projectId,
        apiId: query.get("apiId"),
        stage: query.get("stage"),
      });
    }
    return queryMetrics(db, actor, {
      projectId,
      metric: query.get("metric"),
      apiId: query.get("apiId"),
      stage: query.get("stage"),
      dims: parseDims(query.get("dims")),
      stat: query.get("stat") ?? "Sum",
      period: query.get("period") ?? 300,
      from: query.get("from"),
      to: query.get("to"),
    });
  },
  { deps },
);
