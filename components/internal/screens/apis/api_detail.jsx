"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  Activity, ArrowLeftRight, BookOpen, Bot, Braces, Clock3, FolderTree, Globe, Layers, LayoutDashboard,
  MessageSquareWarning, Network, Package, Plug, Rocket, Route, Settings, ShieldCheck,
} from "lucide-react";
import { EmptyState, SectionCard } from "@/components/internal/shared/screen_kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { useWorkspaceNav } from "@/context/workspace-nav-context";
import { EditorHeader, EditorShell } from "@/components/internal/shared/editor_shell";
import { MainScreenWrapper } from "@/components/internal/shared/screen_wrappers";
import { LoadingArea } from "@/components/internal/workspace/workspace_states";
import { productHref } from "@/lib/workspace/model.mjs";
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
import { DocsTab } from "../distribution/docs_tab";
import { ImportWizard } from "../distribution/import_wizard";
import { ExportDialog } from "../distribution/export_dialog";
import { SdkPanel } from "../distribution/sdk_panel";
import { AgentToolsPanel } from "../distribution/agent_tools_panel";
import { DeployButton } from "../releases/deploy_dialog";
import { MonitoringOverview } from "../monitoring/monitoring_overview";

function ComingPanel({ tab }) {
  return <SectionCard>
    <EmptyState
      icon={Clock3}
      title={`${tab.title} ${NOT_AVAILABLE.toLowerCase()}`}
      description={`The ${tab.title.toLowerCase()} editor isn't available yet. Draft data you create here is kept for it.`}
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
  // Metric rows are keyed by the API's internal id, not its public id.
  return <MonitoringOverview apiId={api.id} />;
}

// Sections that show what each stage is serving; they remount after a deploy.
const LIVE_TABS = new Set(["overview", "deployments", "stages"]);

function TabBody({ tab, api, stages, onNavigate, onChanged }) {
  switch (tab) {
    case "overview": return <OverviewTab api={api} stages={stages} onNavigate={onNavigate} />;
    case "resources": return <ResourcesTab api={api} />;
    case "routes": return <RoutesTab api={api} />;
    case "integrations": return <IntegrationsPanel api={api} />;
    case "authorizers": return <AuthorizersPanel api={api} />;
    case "models": return <ModelsPanel api={api} />;
    case "cors": return <CorsPanel api={api} />;
    case "gateway-responses": return <GatewayResponsesPanel api={api} />;
    case "deployments": return <DeploymentsTab api={api} stages={stages} onChanged={onChanged} />;
    case "stages": return <StagesTab api={api} />;
    case "docs": return <DocsTab api={api} stages={stages} />;
    case "import-export": return <div className="space-y-4"><ImportWizard api={api} /><ExportDialog api={api} stages={stages} /></div>;
    case "sdks": return <SdkPanel api={api} stages={stages} />;
    case "agent-tools": return <AgentToolsPanel api={api} stages={stages} />;
    case "monitoring": return <MonitoringPanel api={api} />;
    case "settings": return <SettingsTab api={api} />;
    default: return null;
  }
}

// Section nav for the editor, grouped like the event editor's. tabs.js stays
// the source of which tabs exist per protocol; this only adds presentation.
const TAB_GROUPS = [
  { group: null, slugs: ["overview"] },
  { group: "Build", slugs: ["resources", "routes", "integrations", "authorizers", "models", "cors", "gateway-responses"] },
  { group: "Release", slugs: ["deployments", "stages"] },
  { group: "Observe", slugs: ["monitoring"] },
  { group: "Distribute", slugs: ["docs", "import-export", "sdks", "agent-tools"] },
  { group: "Configure", slugs: ["settings"] },
];

const TAB_META = {
  overview: { icon: LayoutDashboard, desc: "A snapshot of this API: protocol, endpoint and what's deployed." },
  resources: { icon: FolderTree, desc: "The resource tree and the methods on each path." },
  routes: { icon: Route, desc: "Route keys and the integration each one targets." },
  integrations: { icon: Plug, desc: "Backends your methods and routes call." },
  authorizers: { icon: ShieldCheck, desc: "JWT, Lambda-style and Cognito authorizers." },
  models: { icon: Braces, desc: "JSON schemas for request and response bodies." },
  cors: { icon: Globe, desc: "Cross-origin rules applied before your routes." },
  "gateway-responses": { icon: MessageSquareWarning, desc: "What callers see when the gateway itself rejects a request." },
  deployments: { icon: Rocket, desc: "Immutable snapshots of the draft, ready to put on a stage." },
  stages: { icon: Layers, desc: "Named environments serving a deployment." },
  monitoring: { icon: Activity, desc: "Requests, latency and errors for this API." },
  docs: { icon: BookOpen, desc: "Documentation parts and published versions." },
  "import-export": { icon: ArrowLeftRight, desc: "Bring in an OpenAPI document or export this API." },
  sdks: { icon: Package, desc: "Generated client SDKs per stage." },
  "agent-tools": { icon: Bot, desc: "Expose this API as tools for AI agents." },
  settings: { icon: Settings, desc: "Name, endpoint type and danger zone." },
};

function navGroups(tabs) {
  const bySlug = new Map(tabs.map((entry) => [entry.slug, entry]));
  return TAB_GROUPS
    .map(({ group, slugs }) => ({
      group,
      items: slugs.filter((slug) => bySlug.has(slug)).map((slug) => ({
        key: slug,
        label: bySlug.get(slug).title,
        icon: TAB_META[slug]?.icon,
        desc: TAB_META[slug]?.desc,
      })),
    }))
    .filter((group) => group.items.length > 0);
}

// The tab segment of /project/:id/apis/:apiId/:tab, if the path has one.
function tabFromPath(pathname) {
  const segments = String(pathname ?? "").split("/");
  const at = segments.indexOf("apis");
  return at >= 0 && segments[at + 2] ? decodeURIComponent(segments[at + 2]) : null;
}

export function ApiDetailScreen({ params }) {
  // Remount per API so loading state resets without setState-in-effect.
  return <Detail key={params?.apiId} params={params} />;
}

function Detail({ params }) {
  const { project } = useProject();
  const { can } = useRbac();
  const { memory, projectId, navigate } = useWorkspaceNav();
  const pathname = usePathname();
  const [memoryTab, setMemoryTab] = useState(params?.tab ?? "overview");
  const apiId = params?.apiId;
  // Switching tabs only swaps the editor body, like the event editor's ?section=:
  // pushState keeps this screen mounted (no server render, no route loader) and
  // usePathname follows it, so back/forward land on the right tab too.
  const tab = memory ? memoryTab : tabFromPath(pathname) ?? params?.tab ?? "overview";
  const selectTab = (slug) => {
    if (memory) setMemoryTab(slug);
    else window.history.pushState(null, "", productHref(`/project/${encodeURIComponent(projectId)}/apis/${encodeURIComponent(apiId)}/${slug}`));
  };
  const [state, setState] = useState({ status: "loading", api: null, error: null });
  const [stages, setStages] = useState([]);
  const [attempt, setAttempt] = useState(0);
  // Bumped after a deploy: refetches stages and remounts the sections that show
  // what is live, instead of reloading the whole page.
  const [revision, setRevision] = useState(0);
  const markChanged = () => setRevision((n) => n + 1);

  useEffect(() => {
    let alive = true;
    fetchApis(project.id, `/${encodeURIComponent(apiId)}`).then(
      (api) => { if (alive) setState({ status: "ready", api, error: null }); },
      (error) => { if (alive) setState({ status: "error", api: null, error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id, apiId, attempt]);

  useEffect(() => {
    let alive = true;
    fetchApis(project.id, `/${encodeURIComponent(apiId)}/stages`).then(
      (data) => { if (alive) setStages(data.items ?? []); },
      () => { if (alive) setStages([]); },
    );
    return () => { alive = false; };
  }, [project.id, apiId, revision]);

  const back = { label: "All APIs", onClick: () => navigate("apis") };

  if (state.status === "loading") {
    return <LoadingArea label="Loading API" />;
  }
  if (state.status === "error") {
    return <MainScreenWrapper>
      <EditorHeader back={back} title="API unavailable" />
      <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
        icon={Network}
        title="API unavailable"
        description={state.error}
        action={<Button
          variant="outline"
          className="border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground"
          onClick={() => { setState({ status: "loading", api: null, error: null }); setAttempt((n) => n + 1); }}
        >Retry</Button>}
      /></div>
    </MainScreenWrapper>;
  }

  const api = state.api;
  const tabs = tabsForProtocol(api.protocol);
  const active = tabs.find((entry) => entry.slug === tab) ?? tabs[0];

  return <EditorShell
    back={back}
    title={api.name}
    badges={<>
      <Badge variant="outline">{api.protocol}</Badge>
      <Badge variant="outline">{api.endpointType}</Badge>
      <span className="font-mono text-xs text-text-secondary">{api.publicId}</span>
    </>}
    meta={api.description || undefined}
    actions={can("pods.deployment.create") ? <DeployButton api={api} stages={stages} onDeployed={markChanged} /> : null}
    nav={navGroups(tabs)}
    active={active.slug}
    onActiveChange={selectTab}
  >
    {/* Every wired tab mounts with the editor and stays mounted, so all tab
        data loads once up front and switching only toggles visibility (no
        refetch). The plain wrapper divs keep a panel's bare LoadingArea
        (h-full) sized to its content instead of the full-height column. */}
    {() => <div>
      {tabs.filter((entry) => entry.wired).map((entry) => <div key={LIVE_TABS.has(entry.slug) ? `${entry.slug}:${revision}` : entry.slug} hidden={entry.slug !== active.slug}>
        <TabBody tab={entry.slug} api={api} stages={stages} onNavigate={selectTab} onChanged={markChanged} />
      </div>)}
      {!active.wired ? <ComingPanel tab={active} /> : null}
    </div>}
  </EditorShell>;
}
