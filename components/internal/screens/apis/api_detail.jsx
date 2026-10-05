"use client";

import { useEffect, useState } from "react";
import { Clock3, Network } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { NOT_AVAILABLE, tabsForProtocol } from "./tabs";
import { fetchApis } from "./api_list";
import { OverviewTab } from "./overview_tab";
import { ResourcesTab } from "./resources_tab";
import { RoutesTab } from "./routes_tab";
import { SettingsTab } from "./settings_tab";
import { IntegrationsTab } from "../integrations/integrations_tab";
import { AuthorizersTab } from "../auth/authorizers_tab";
import { CorsPanel, GatewayResponsesPanel, ModelsPanel } from "./tab_panels";
import { DeploymentsTab } from "../releases/deployments_tab";
import { StagesTab } from "../releases/stages_tab";
import { DeployButton } from "../releases/deploy_dialog";
import { MonitoringOverview } from "../monitoring/monitoring_overview";

function ComingPanel({ tab }) {
  return <SectionCard>
    <EmptyState
      icon={Clock3}
      title={`${tab.title} ${NOT_AVAILABLE.toLowerCase()}`}
      description={`The ${tab.title.toLowerCase()} editor arrives in ${tab.owner}. Draft data you create here is preserved for it.`}
    />
  </SectionCard>;
}

function AuthorizersPanel({ api }) {
  return <AuthorizersTab api={api} />;
}

function IntegrationsPanel({ api }) {
  return <IntegrationsTab apiId={api.publicId ?? api.id} protocol={api.protocol} />;
}

function MonitoringPanel({ api }) {
  return <MonitoringOverview apiId={api.publicId ?? api.id} />;
}

function TabBody({ tab, api, stages }) {
  switch (tab) {
    case "overview": return <OverviewTab api={api} />;
    case "resources": return <ResourcesTab api={api} />;
    case "routes": return <RoutesTab api={api} />;
    case "integrations": return <IntegrationsPanel api={api} />;
    case "authorizers": return <AuthorizersPanel api={api} />;
    case "models": return <ModelsPanel api={api} />;
    case "cors": return <CorsPanel api={api} />;
    case "gateway-responses": return <GatewayResponsesPanel api={api} />;
    case "deployments": return <DeploymentsTab api={api} stages={stages} />;
    case "stages": return <StagesTab api={api} />;
    case "monitoring": return <MonitoringPanel api={api} />;
    case "settings": return <SettingsTab api={api} />;
    default: return null;
  }
}

export function ApiDetailScreen({ params }) {
  // Remount per API so loading state resets without setState-in-effect.
  return <Detail key={params?.apiId} params={params} />;
}

function Detail({ params }) {
  const { project } = useProject();
  const { can } = useRbac();
  const apiId = params?.apiId;
  const tab = params?.tab ?? "overview";
  const [state, setState] = useState({ status: "loading", api: null, error: null });
  const [stages, setStages] = useState([]);

  useEffect(() => {
    let alive = true;
    fetchApis(project.id, `/${encodeURIComponent(apiId)}`).then(
      (api) => { if (alive) setState({ status: "ready", api, error: null }); },
      (error) => { if (alive) setState({ status: "error", api: null, error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id, apiId]);

  useEffect(() => {
    let alive = true;
    fetchApis(project.id, `/${encodeURIComponent(apiId)}/stages`).then(
      (data) => { if (alive) setStages(data.items ?? []); },
      () => { if (alive) setStages([]); },
    );
    return () => { alive = false; };
  }, [project.id, apiId]);

  if (state.status === "loading") {
    return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
      <SectionCard><div className="flex justify-center py-10"><LogoLoading /></div></SectionCard>
    </div>;
  }
  if (state.status === "error") {
    return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
      <SectionCard><EmptyState
        icon={Network}
        title="API unavailable"
        description={state.error}
        action={<Button variant="outline" onClick={() => window.location.reload()}>Retry</Button>}
      /></SectionCard>
    </div>;
  }

  const api = state.api;
  const tabs = tabsForProtocol(api.protocol);
  const active = tabs.find((entry) => entry.slug === tab);

  return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
    <ScreenHeader
      title={api.name}
      description={`${api.protocol} API · ${api.publicId}`}
      actions={<span className="flex items-center gap-2">
        <Badge variant="outline">{api.protocol}</Badge>
        {can("pods.deployment.create") ? <DeployButton api={api} stages={stages} onDeployed={() => window.location.reload()} /> : null}
      </span>}
    />
    <nav className="flex flex-wrap gap-1 border-b border-border pb-px" aria-label="API sections">
      {tabs.map((entry) => {
        const selected = entry.slug === tab;
        return <a
          key={entry.slug}
          href={entry.slug}
          aria-current={selected ? "page" : undefined}
          className={`rounded-t-md px-3 py-2 text-sm ${selected ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground"}`}
        >{entry.title}{entry.owner && !entry.wired ? <span className="ml-1 text-xs opacity-60">{entry.owner}</span> : null}</a>;
      })}
    </nav>
    {!active ? <SectionCard><EmptyState icon={Network} title="Tab unavailable" description={`The ${tab} tab is not available for ${api.protocol} APIs.`} /></SectionCard> : null}
    {active && !active.wired ? <ComingPanel tab={active} /> : null}
    {active?.wired ? <TabBody tab={active.slug} api={api} stages={stages} /> : null}
  </div>;
}
