// The signed-in visitor and the project the playground workspace opens, in the
// shapes the real session (Supabase auth user) and project contexts
// (lib/supabase/projects.js listAccessibleProjects) produce. No seed imports,
// so the landing page can use these without pulling in the database.

import { PLAYGROUND_PROJECT } from "./mode.js";
import { PLAYGROUND_PERSON } from "./cast.js";

export const PLAYGROUND_USER = {
  id: PLAYGROUND_PERSON.id,
  email: PLAYGROUND_PERSON.email,
  user_metadata: { full_name: PLAYGROUND_PERSON.name, avatar_url: PLAYGROUND_PERSON.avatar_url },
  app_metadata: {},
  aud: "authenticated",
  role: "authenticated",
};

// The visitor owns the project, so every screen and action is unlocked.
export const PLAYGROUND_WORKSPACE_PROJECT = {
  id: PLAYGROUND_PROJECT.id,
  name: PLAYGROUND_PROJECT.name,
  slug: PLAYGROUND_PROJECT.slug,
  organizationId: PLAYGROUND_PROJECT.organization_id,
  createdBy: PLAYGROUND_USER.id,
  status: "active",
  createdAt: new Date(Date.now() - 400 * 864e5).toISOString(),
  inheritedRole: "owner",
};
