import { LayoutDashboard, Network, Layers, ShieldCheck, Globe, Activity, Route, Settings } from "lucide-react";

export const workspaceNav = [
  { title: "Overview", slug: "overview", icon: LayoutDashboard },
  { title: "APIs", slug: "apis", icon: Network, phase: 1 },
  { title: "Deployments", slug: "deployments", icon: Layers, phase: 2 },
  { title: "Access", slug: "access", icon: ShieldCheck, phase: 3 },
  { title: "Domains", slug: "domains", icon: Globe, phase: 7 },
  { title: "Monitoring", slug: "monitoring", icon: Activity, phase: 6 },
  { title: "Roadmap", slug: "roadmap", icon: Route },
  { title: "Project details", slug: "settings", icon: Settings },
];
