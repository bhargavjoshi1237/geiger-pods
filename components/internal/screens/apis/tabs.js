// API detail tab registry (S03 §5). The detail shell renders one tab per
// slug; tabs owned by parallel specs (S04 integrations, S05 deployments +
// stages, S06 models/cors/gateway-responses, S07 authorizers, S10
// monitoring, S13 docs) map to `component: null` and show a "Not available
// yet" panel. This file stays import-free on purpose: the orchestrator wires
// the real S04/S06 components later without touching S03 files.

export const NOT_AVAILABLE = "Not available yet";

/** Tabs in display order: slug, title, protocols, owner spec (null = S03). */
export const API_TABS = [
  { slug: "overview", title: "Overview", protocols: ["REST", "HTTP", "WEBSOCKET"], owner: null },
  { slug: "resources", title: "Resources", protocols: ["REST"], owner: null },
  { slug: "routes", title: "Routes", protocols: ["HTTP", "WEBSOCKET"], owner: null },
  { slug: "integrations", title: "Integrations", protocols: ["REST", "HTTP", "WEBSOCKET"], owner: "S04" },
  { slug: "authorizers", title: "Authorizers", protocols: ["REST", "HTTP", "WEBSOCKET"], owner: "S07" },
  { slug: "models", title: "Models", protocols: ["REST", "WEBSOCKET"], owner: "S06" },
  { slug: "cors", title: "CORS", protocols: ["HTTP"], owner: "S06" },
  { slug: "gateway-responses", title: "Gateway responses", protocols: ["REST"], owner: "S06" },
  { slug: "deployments", title: "Deployments", protocols: ["REST", "HTTP", "WEBSOCKET"], owner: "S05" },
  { slug: "stages", title: "Stages", protocols: ["REST", "HTTP", "WEBSOCKET"], owner: "S05" },
  { slug: "monitoring", title: "Monitoring", protocols: ["REST", "HTTP", "WEBSOCKET"], owner: "S10" },
  { slug: "docs", title: "Docs", protocols: ["REST", "HTTP"], owner: "S13" },
  { slug: "settings", title: "Settings", protocols: ["REST", "HTTP", "WEBSOCKET"], owner: null },
];

/** Tabs visible for one API protocol, in display order. */
export function tabsForProtocol(protocol) {
  return API_TABS.filter((tab) => tab.protocols.includes(protocol));
}
