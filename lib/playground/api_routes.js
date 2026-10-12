// The playground's stand-in for the Pods v1 management API: every
// `fetch(\`/api/v1/projects/${projectId}/…\`)` the workspace screens make is
// answered here from the in-memory seed (see ./intercept_fetch.js), with the
// response shapes of the real route handlers in app/api/v1/** and
// lib/control/*. GETs read the seed; POST/PATCH/PUT/DELETE change it for the
// session.

import { catalogRoutes } from "./api/catalog.js";
import { apiDetailRoutes } from "./api/api_detail.js";
import { usageRoutes } from "./api/usage.js";
import { settingsRoutes } from "./api/settings.js";
import { secretsRoutes } from "./api/secrets.js";
import { connectorsRoutes } from "./api/connectors.js";
import { auditRoutes } from "./api/audit.js";
import { monitoringRoutes } from "./api/monitoring.js";
import { domainsRoutes } from "./api/domains.js";
import { portalsRoutes } from "./api/portals.js";

export const API_ROUTES = [
  ...catalogRoutes,
  ...apiDetailRoutes,
  ...usageRoutes,
  ...settingsRoutes,
  ...secretsRoutes,
  ...connectorsRoutes,
  ...auditRoutes,
  ...monitoringRoutes,
  ...domainsRoutes,
  ...portalsRoutes,
];
