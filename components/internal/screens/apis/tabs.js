// API detail tab registry (S03 §5, wired by C1). The detail shell renders one
// tab per slug; `wired: true` tabs mount their owning spec's component in
// `api_detail.jsx`. Only tabs owned by specs without delivered UI (S09 cache /
// canary stage sub-tabs live under stages, S11, S12, S13 docs) keep
// `wired: false` and show a "Not available yet" panel. This file stays
// import-free on purpose so node:test can assert the wiring map.

export const NOT_AVAILABLE = "Not available yet";

/**
 * Tabs in display order: slug, title, protocols, owner spec (null = S03) and
 * whether the detail shell mounts a real component (`wired`) or the
 * coming-soon panel.
 */
export const API_TABS = [
  { slug: "overview", title: "Overview", protocols: ["REST", "HTTP", "WEBSOCKET"], owner: null, wired: true },
  { slug: "resources", title: "Resources", protocols: ["REST"], owner: null, wired: true },
  { slug: "routes", title: "Routes", protocols: ["HTTP", "WEBSOCKET"], owner: null, wired: true },
  { slug: "integrations", title: "Integrations", protocols: ["REST", "HTTP", "WEBSOCKET"], owner: "S04", wired: true },
  { slug: "authorizers", title: "Authorizers", protocols: ["REST", "HTTP", "WEBSOCKET"], owner: "S07", wired: true },
  { slug: "models", title: "Models", protocols: ["REST", "WEBSOCKET"], owner: "S06", wired: true },
  { slug: "cors", title: "CORS", protocols: ["HTTP"], owner: "S06", wired: true },
  { slug: "gateway-responses", title: "Gateway responses", protocols: ["REST"], owner: "S06", wired: true },
  { slug: "deployments", title: "Deployments", protocols: ["REST", "HTTP", "WEBSOCKET"], owner: "S05", wired: true },
  { slug: "stages", title: "Stages", protocols: ["REST", "HTTP", "WEBSOCKET"], owner: "S05", wired: true },
  { slug: "monitoring", title: "Monitoring", protocols: ["REST", "HTTP", "WEBSOCKET"], owner: "S10", wired: true },
  { slug: "docs", title: "Docs", protocols: ["REST", "HTTP"], owner: "S13", wired: false },
  { slug: "settings", title: "Settings", protocols: ["REST", "HTTP", "WEBSOCKET"], owner: null, wired: true },
];

/** Tabs visible for one API protocol, in display order. */
export function tabsForProtocol(protocol) {
  return API_TABS.filter((tab) => tab.protocols.includes(protocol));
}
