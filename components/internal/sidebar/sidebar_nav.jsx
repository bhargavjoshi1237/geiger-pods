import {
  Activity,
  Bell,
  BookOpen,
  Boxes,
  Cable,
  FileKey,
  Gauge,
  Globe,
  KeyRound,
  KeySquare,
  LayoutDashboard,
  Network,
  ScrollText,
  Settings,
  Shield,
  ShieldCheck,
  ShieldHalf,
  SlidersHorizontal,
  Ticket,
  UploadCloud,
  Users,
} from "lucide-react";

// Sidebar navigation for Geiger Pods, shaped like geiger-events': top-level
// areas, with a group's destinations as sub-items the parent expands. Only
// leaves are destinations. Each leaf names:
//   path    - the workspace path under /project/:projectId/
//   screens - registry screen keys (lib/workspace/screens.mjs) that light it up
//   section - the workspace section whose `pods.<section>.view` key gates it
// Per-API features (resources, stages, deployments, docs…) live as sections
// inside the API editor, opened from All APIs, so only workspace-level
// destinations appear here.
export const workspaceNav = [
  {
    title: "Overview",
    icon: LayoutDashboard,
    path: "overview",
    section: "overview",
    screens: ["overview"],
  },
  {
    title: "APIs",
    icon: Network,
    path: "apis",
    section: "apis",
    screens: ["apiList", "apiDetail"],
  },
  {
    title: "Usage",
    icon: Gauge,
    subItems: [
      { title: "Usage Plans", icon: Ticket, path: "usage-plans", section: "usage", screens: ["usagePlans"] },
      { title: "API Keys", icon: KeyRound, path: "api-keys", section: "usage", screens: ["apiKeys"] },
    ],
  },
  {
    title: "Security",
    icon: ShieldCheck,
    subItems: [
      { title: "Secrets", icon: KeySquare, path: "secrets", section: "secrets", screens: ["secretList"] },
      { title: "Web Application Firewall", icon: ShieldHalf, path: "waf", section: "domains", screens: ["wafList"] },
      { title: "Signing Credentials", icon: FileKey, path: "access/credentials", section: "settings", screens: ["credentials"] },
    ],
  },
  {
    title: "Networking",
    icon: Globe,
    subItems: [
      { title: "Custom Domains", icon: Globe, path: "domains", section: "domains", screens: ["domainList"] },
      { title: "Trust Stores", icon: Shield, path: "domains/truststores", section: "domains", screens: ["truststoreList"] },
      { title: "Connectors", icon: Cable, path: "connectors", section: "connectors", screens: ["connectorList"] },
    ],
  },
  {
    title: "Monitoring",
    icon: Activity,
    subItems: [
      { title: "Dashboard", icon: Activity, path: "monitoring", section: "monitoring", screens: ["monitoring"] },
      { title: "Logs", icon: ScrollText, path: "monitoring/logs", section: "monitoring", screens: ["logs"] },
      { title: "Alarms", icon: Bell, path: "monitoring/alarms", section: "monitoring", screens: ["alarms"] },
      { title: "Log Exports", icon: UploadCloud, path: "monitoring/exports", section: "monitoring", screens: ["exports"] },
    ],
  },
  {
    title: "Portals",
    icon: BookOpen,
    path: "portals",
    section: "portals",
    screens: ["portalList"],
  },
  {
    title: "Settings",
    icon: Settings,
    subItems: [
      { title: "General", icon: SlidersHorizontal, path: "settings", section: "settings", screens: ["settings", "projectDetails"] },
      { title: "Team & Access", icon: Users, path: "settings/access", section: "settings", screens: ["teamAccess"] },
      { title: "Access Tokens", icon: KeyRound, path: "settings/tokens", section: "settings", screens: ["tokens"] },
      { title: "Stacks", icon: Boxes, path: "settings/stacks", section: "settings", screens: ["stacks"] },
      { title: "Audit Log", icon: ScrollText, path: "audit", section: "audit", screens: ["auditLog"] },
    ],
  },
];

/** Every destination (leaf) in sidebar order. */
export const navLeaves = workspaceNav.flatMap((item) => item.subItems ?? [item]);

/** The leaf a registry screen belongs to, so the sidebar can highlight it. */
export function leafForScreen(screen) {
  if (!screen) return null;
  return navLeaves.find((leaf) => leaf.screens?.includes(screen)) ?? null;
}

/**
 * The nav the current actor may see: leaves gated on their section's view
 * key, groups dropped once they have no visible leaves.
 */
export function visibleNav(can) {
  return workspaceNav
    .map((item) => {
      if (!item.subItems) return can(`pods.${item.section}.view`) ? item : null;
      const subItems = item.subItems.filter((sub) => can(`pods.${sub.section}.view`));
      return subItems.length ? { ...item, subItems } : null;
    })
    .filter(Boolean);
}
