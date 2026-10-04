"use client";

import { EmptyState } from "@geiger/ui/screen-kit";
import { LockKeyhole } from "lucide-react";
import { WorkspaceGate } from "../workspace/workspace_states";
import { useRbac } from "@/context/rbac-context";
import { workspaceNav } from "../sidebar/sidebar_nav";
import { PodsOverview } from "./overview/pods_overview";
import { ProjectDetails } from "./project_details";
import { Roadmap } from "./roadmap";
import { PlannedScreen } from "./planned_screen";

const screens = { overview: PodsOverview, settings: ProjectDetails, roadmap: Roadmap };

function AuthorizedScreen({ section }) {
  const { can } = useRbac();
  if (!can(`pods.${section}.view`)) return <EmptyState icon={LockKeyhole} title="Access unavailable" description="Your current team access does not allow this screen." />;
  const Screen = screens[section];
  return Screen ? <Screen /> : <PlannedScreen item={workspaceNav.find((item) => item.slug === section)} />;
}

export function ProjectScreen({ section }) {
  return <WorkspaceGate><AuthorizedScreen section={section} /></WorkspaceGate>;
}
