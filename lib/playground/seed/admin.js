// Access tokens, tags, stacks and event subscriptions. Rows mirror supabase/migrations/admin.

import { PROJECT_ID, daysAgo, sid } from "./helpers.js";
import { personId } from "../cast.js";
import { API_SPECS, apiId, apiTags } from "./catalog.js";

export function adminSeed() {
  // Generic tag rows (what the Tags editor reads) for every API.
  const tags = API_SPECS.flatMap((spec) => Object.entries(apiTags(spec))
    .map(([key, value]) => ({ spec, key, value })))
    .map(({ spec, key, value }, index) => ({
      id: sid("tag", index + 1),
      project_id: PROJECT_ID,
      resource_type: "api",
      resource_id: apiId(spec.n),
      key,
      value,
      created_by: personId(spec.owner),
      created_at: daysAgo(spec.created),
      updated_at: daysAgo(spec.created),
    }));
  return { tags };
}
