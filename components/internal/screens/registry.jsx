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
import { SecretsScreen } from "./secrets/secrets_screen";
import { SettingsScreen } from "./settings/project_settings";
import { TeamAccessScreen } from "./settings/team_access";
import { ApiDetailScreen } from "./apis/api_detail";
import { ApiListScreen } from "./apis/api_list";
import { ConnectorsScreen } from "./connectors/connectors_screen";

const screens = {
  overview: PodsOverview,
  settings: SettingsScreen,
  teamAccess: TeamAccessScreen,
  secretList: SecretsScreen,
  apiList: ApiListScreen,
  apiDetail: ApiDetailScreen,
  connectorList: ConnectorsScreen,
  projectDetails: ProjectDetails,
  roadmap: Roadmap,
};

// Default screen per section for callers that only know the section.
const defaultScreen = {
  overview: "overview",
  apis: "apiList",
  connectors: "connectorList",
  settings: "settings",
  secrets: "secretList",
  roadmap: "roadmap",
};

function AuthorizedScreen({ section, screen, params }) {
  const { can } = useRbac();
  if (!can(`pods.${section}.view`)) return <EmptyState icon={LockKeyhole} title="Access unavailable" description="Your current team access does not allow this screen." />;
  const key = screen ?? defaultScreen[section];
  const Screen = key ? screens[key] : null;
  if (Screen) return <Screen params={params} />;
  return <PlannedScreen item={workspaceNav.find((item) => item.slug === section)} />;
}

export function ProjectScreen({ section, screen, params }) {
  return <WorkspaceGate><AuthorizedScreen section={section} screen={screen} params={params} /></WorkspaceGate>;
}
