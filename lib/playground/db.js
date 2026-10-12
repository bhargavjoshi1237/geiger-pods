// The playground's in-memory database: every seeded table, built lazily the
// first time the playground queries it and kept for the rest of the page
// session, so edits survive tab switches but a reload starts fresh. Table
// names are the `pods.*` tables (and the shared public.projects/profiles).

import { createMemoryDb } from "./memory_client.js";
import { PLAYGROUND_PROJECT } from "./mode.js";
import { PEOPLE, PLAYGROUND_PERSON, STUDIO } from "./cast.js";
import { PLAYGROUND_USER } from "./workspace.js";
import { catalogSeed } from "./seed/catalog.js";
import { integrationsSeed } from "./seed/integrations.js";
import { releasesSeed } from "./seed/releases.js";
import { authorizersSeed } from "./seed/authorizers.js";
import { processingSeed } from "./seed/processing.js";
import { distributionSeed } from "./seed/distribution.js";
import { usageSeed } from "./seed/usage.js";
import { foundationSeed } from "./seed/foundation.js";
import { adminSeed } from "./seed/admin.js";
import { signingSeed } from "./seed/signing.js";
import { observabilitySeed } from "./seed/observability.js";
import { domainsSeed } from "./seed/domains.js";
import { portalsSeed } from "./seed/portals.js";

export { PLAYGROUND_USER };

export const getPlaygroundDb = createMemoryDb(() => ({
  projects: [
    {
      id: PLAYGROUND_PROJECT.id,
      name: PLAYGROUND_PROJECT.name,
      slug: PLAYGROUND_PROJECT.slug,
      organization_id: PLAYGROUND_PROJECT.organization_id,
      created_by: PLAYGROUND_PERSON.id,
      status: "active",
      created_at: new Date(Date.now() - 400 * 864e5).toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    },
  ],
  profiles: PEOPLE.map((p) => ({
    id: p.id,
    email: p.email,
    full_name: p.name,
    avatar_url: p.avatar_url,
    title: p.title,
    organization: STUDIO.name,
  })),
  ...catalogSeed(),
  ...integrationsSeed(),
  ...releasesSeed(),
  ...authorizersSeed(),
  ...processingSeed(),
  ...distributionSeed(),
  ...usageSeed(),
  ...foundationSeed(),
  ...adminSeed(),
  ...signingSeed(),
  ...observabilitySeed(),
  ...domainsSeed(),
  ...portalsSeed(),
}));
