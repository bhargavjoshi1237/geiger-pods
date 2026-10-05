import { LayoutDashboard, Network, KeyRound, Globe, Cable, KeySquare, Activity, BookOpen, ScrollText, Settings, Route } from "lucide-react";

export const workspaceNav = [
  { title: "Overview", slug: "overview", icon: LayoutDashboard },
  { title: "APIs", slug: "apis", icon: Network, phase: 1 },
  { title: "Usage plans & keys", slug: "usage", icon: KeyRound, phase: 3 },
  { title: "Custom domains", slug: "domains", icon: Globe, phase: 7 },
  { title: "Connectors", slug: "connectors", icon: Cable, phase: 7 },
  { title: "Secrets", slug: "secrets", icon: KeySquare },
  { title: "Monitoring", slug: "monitoring", icon: Activity, phase: 6 },
  { title: "Portals", slug: "portals", icon: BookOpen, phase: 9 },
  { title: "Audit", slug: "audit", icon: ScrollText, phase: 6 },
  { title: "Settings", slug: "settings", icon: Settings },
  { title: "Roadmap", slug: "roadmap", icon: Route },
];
