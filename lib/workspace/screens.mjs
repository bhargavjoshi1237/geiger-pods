// Workspace screen registry (S02). Phase 0 only knew single-segment sections;
// nested workspace URLs (API detail pages, settings sub-pages) match here.
// Pure ES module: safe to import from client components and from node tests.

/** Sidebar sections in display order. Also the source of `pods.<section>.view` keys. */
export const SECTIONS = [
  "overview",
  "apis",
  "usage",
  "domains",
  "connectors",
  "secrets",
  "monitoring",
  "portals",
  "audit",
  "settings",
  "roadmap",
];

/** Human titles for the sidebar and permission labels. */
export const SECTION_TITLES = {
  overview: "Overview",
  apis: "APIs",
  usage: "Usage plans & keys",
  domains: "Custom domains",
  connectors: "Connectors",
  secrets: "Secrets",
  monitoring: "Monitoring",
  portals: "Portals",
  audit: "Audit",
  settings: "Settings",
  roadmap: "Roadmap",
};

/** Tabs allowed on the API detail screen (`/apis/:apiId/:tab`). */
export const API_DETAIL_TABS = [
  "overview",
  "resources", // S03 (REST)
  "routes",
  "integrations",
  "authorizers",
  "models", // S06 (REST/WS)
  "cors", // S06 (HTTP)
  "gateway-responses", // S06 (REST)
  "deployments",
  "stages", // S05
  "monitoring",
  "settings",
  "docs", // S13
];

/**
 * Screen registry. Later specs add rows; each row maps a URL pattern to a
 * section (sidebar highlight + `pods.<section>.view` gate) and a screen.
 * `:name` segments capture params. Unknown patterns resolve to null.
 */
export const SCREENS = [
  { pattern: [], section: "overview", screen: "overview" },
  { pattern: ["apis"], section: "apis", screen: "apiList" },
  { pattern: ["apis", ":apiId"], section: "apis", screen: "apiDetail" },
  { pattern: ["apis", ":apiId", ":tab"], section: "apis", screen: "apiDetail" },
  { pattern: ["usage"], section: "usage", screen: "usagePlans" },
  { pattern: ["domains"], section: "domains", screen: "domainList" },
  { pattern: ["connectors"], section: "connectors", screen: "connectorList" },
  { pattern: ["secrets"], section: "secrets", screen: "secretList" },
  { pattern: ["monitoring"], section: "monitoring", screen: "monitoring" },
  { pattern: ["portals"], section: "portals", screen: "portalList" },
  { pattern: ["audit"], section: "audit", screen: "auditLog" },
  { pattern: ["settings"], section: "settings", screen: "settings" },
  { pattern: ["settings", "access"], section: "settings", screen: "teamAccess" },
  { pattern: ["roadmap"], section: "roadmap", screen: "roadmap" },
];

/**
 * Match URL segments against the registry.
 * @param {string[]|undefined|null} rest
 * @returns {{ section: string, screen: string, params: Record<string,string> } | null}
 */
export function resolveScreen(rest) {
  const segments = Array.isArray(rest) ? rest : [];
  for (const entry of SCREENS) {
    if (entry.pattern.length !== segments.length) continue;
    const params = {};
    let matches = true;
    for (let index = 0; index < entry.pattern.length; index += 1) {
      const token = entry.pattern[index];
      if (token.startsWith(":")) {
        params[token.slice(1)] = segments[index];
      } else if (token !== segments[index]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    if (entry.screen === "apiDetail" && params.tab !== undefined && !API_DETAIL_TABS.includes(params.tab)) continue;
    return { section: entry.section, screen: entry.screen, params };
  }
  return null;
}
