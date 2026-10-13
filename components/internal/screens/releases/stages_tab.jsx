"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Copy, History, Layers, Loader2, RotateCcw, Settings2 } from "lucide-react";
import { DataTable, EmptyState, Field, LoadingArea, SectionCard, SegmentedTabs } from "@/components/internal/shared/screen_kit";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { StageThrottleTab } from "../usage/stage_throttle_tab";
import { StageLoggingTab } from "../monitoring/stage_logging_tab";
import { CanaryTab } from "./canary_tab";
import { CacheTab } from "./cache_tab";

const PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";
const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

const SUB_TABS = [
  { value: "settings", label: "Settings" },
  { value: "canary", label: "Canary" },
  { value: "cache", label: "Cache" },
  { value: "throttling", label: "Throttling" },
  { value: "logging", label: "Logs & tracing" },
  { value: "history", label: "History" },
];

const HISTORY_REASON = { created: "Created", deploy: "Deploy", rollback: "Rollback", auto_deploy: "Auto-deploy", canary_promote: "Canary promoted" };

async function call(projectId, apiId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/apis/${encodeURIComponent(apiId)}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

function shortId(value) {
  return String(value ?? "—").slice(0, 8);
}

function copyInvokeUrl(url) {
  navigator.clipboard?.writeText(url).then(
    () => toast.success("Invoke URL copied."),
    () => toast.error("Copy failed."),
  );
}

/**
 * Stages section: every stage in a table (deployment served, invoke URL,
 * auto-deploy and canary badges). Opening a stage swaps the table for that
 * stage's settings, canary, cache, throttling, logs & tracing and history.
 */
export function StagesTab({ api }) {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [selectedId, setSelectedId] = useState(null);
  const [openTab, setOpenTab] = useState("settings");

  // Refetches in place once loaded, so an open stage keeps its sub-tab while
  // a child (canary, cache) reports a change.
  const refresh = useCallback(async () => {
    setState((current) => (current.status === "ready" ? current : { status: "loading", items: [], error: null }));
    try {
      const data = await call(project.id, api.id ?? api.publicId, "/stages");
      setState({ status: "ready", items: data.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [project.id, api.id, api.publicId]);

  useEffect(() => {
    let alive = true;
    call(project.id, api.id ?? api.publicId, "/stages").then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id, api.id, api.publicId]);

  const open = (stage, tab = "settings") => {
    setOpenTab(tab);
    setSelectedId(stage.id);
  };

  if (state.status === "loading") {
    return <LoadingArea panel label="Loading stages" />;
  }
  if (state.status === "error") {
    return <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={Layers} title="Stages unavailable" description={state.error} action={<Button variant="outline" className={SECONDARY} onClick={refresh}>Retry</Button>} /></div>;
  }

  const selected = state.items.find((stage) => stage.id === selectedId) ?? null;
  if (selected) {
    return <StageDetail
      key={selected.id}
      api={api}
      stage={selected}
      initialTab={openTab}
      onBack={() => setSelectedId(null)}
      onChanged={refresh}
      can={can}
      projectId={project.id}
    />;
  }

  const columns = [
    {
      key: "stage",
      header: "Stage",
      render: (stage) => <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">{stage.name}</span>
          {stage.autoDeploy ? <Badge variant="info">Auto-deploy</Badge> : null}
          {stage.canary ? <Badge variant="warning">Canary</Badge> : null}
        </div>
        {stage.description ? <p className="mt-0.5 max-w-[26rem] truncate text-xs text-text-secondary">{stage.description}</p> : null}
      </div>,
    },
    {
      key: "deployment",
      header: "Serving",
      render: (stage) => stage.deploymentId
        ? <span className="font-mono text-sm text-foreground" title={stage.deploymentId}>{shortId(stage.deploymentId)}</span>
        : <span className="text-sm text-text-tertiary">No deployment yet</span>,
    },
    {
      key: "invokeUrl",
      header: "Invoke URL",
      className: "max-w-72",
      render: (stage) => stage.invokeUrl
        ? <div className="flex min-w-0 items-center gap-1" onClick={(event) => event.stopPropagation()}>
          <code className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={stage.invokeUrl}>{stage.invokeUrl}</code>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Copy ${stage.name} invoke URL`}
            className="shrink-0 text-text-secondary hover:bg-surface-active hover:text-foreground"
            onClick={() => copyInvokeUrl(stage.invokeUrl)}
          ><Copy className="size-4" /></Button>
        </div>
        : <span className="text-xs text-text-tertiary">—</span>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (stage) => <ActionMenu
        label={`Actions for ${stage.name}`}
        items={[
          { icon: Settings2, label: "Open", onSelect: () => open(stage) },
          { icon: History, label: "Deployment history", onSelect: () => open(stage, "history") },
          stage.invokeUrl && { icon: Copy, label: "Copy invoke URL", onSelect: () => copyInvokeUrl(stage.invokeUrl) },
        ]}
      />,
    },
  ];

  return <DataTable
    columns={columns}
    data={state.items}
    getRowKey={(stage) => stage.id ?? stage.name}
    onRowClick={(stage) => open(stage)}
    empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={Layers} title="No stages yet" description="Deploy the API to create the first stage." /></div>}
  />;
}

function StageDetail({ api, stage, initialTab, onBack, onChanged, can, projectId }) {
  const [subTab, setSubTab] = useState(initialTab ?? "settings");
  const [variablesText, setVariablesText] = useState(JSON.stringify(stage.variables ?? {}, null, 2));
  const [history, setHistory] = useState({ status: initialTab === "history" ? "loading" : "idle", items: [] });
  const [busy, setBusy] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState(null);
  const apiRef = api.publicId ?? api.id;
  const canPromote = can("pods.stage.promote");

  const saveVariables = async () => {
    let variables;
    try {
      variables = JSON.parse(variablesText);
    } catch {
      toast.error("Variables must be valid JSON.");
      return;
    }
    setBusy(true);
    try {
      await call(projectId, api.id ?? api.publicId, `/stages/${encodeURIComponent(stage.name)}`, {
        method: "PATCH",
        headers: { "If-Match": String(stage.version) },
        body: JSON.stringify({ variables }),
      });
      toast.success(`Saved variables for ${stage.name}.`);
      onChanged();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const historyPath = `/stages/${encodeURIComponent(stage.name)}/history`;

  const loadHistory = async () => {
    setHistory({ status: "loading", items: [] });
    try {
      const data = await call(projectId, api.id ?? api.publicId, historyPath);
      setHistory({ status: "ready", items: data.items ?? [] });
    } catch (error) {
      setHistory({ status: "error", items: [], error: error.message });
    }
  };

  // Opening straight onto History (from the stage's action menu) loads it once.
  useEffect(() => {
    if (initialTab !== "history") return undefined;
    let alive = true;
    call(projectId, api.id ?? api.publicId, historyPath).then(
      (data) => { if (alive) setHistory({ status: "ready", items: data.items ?? [] }); },
      (error) => { if (alive) setHistory({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rollback = async (deploymentId) => {
    if (!canPromote) {
      toast.error("Your current team access does not allow promoting.");
      return;
    }
    setBusy(true);
    try {
      await call(projectId, api.id ?? api.publicId, `/stages/${encodeURIComponent(stage.name)}/rollback`, {
        method: "POST",
        body: JSON.stringify({ deploymentId }),
      });
      toast.success(`Rolled back ${stage.name}.`);
      setRollbackTarget(null);
      onChanged();
      loadHistory();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const historyColumns = [
    {
      key: "reason",
      header: "Change",
      render: (entry) => <Badge variant={entry.reason === "rollback" ? "warning" : "neutral"}>{HISTORY_REASON[entry.reason] ?? entry.reason}</Badge>,
    },
    {
      key: "deployments",
      header: "Deployment",
      render: (entry) => <span className="font-mono text-xs text-muted-foreground">
        {shortId(entry.fromDeploymentId)} <span className="text-text-tertiary">→</span> {shortId(entry.toDeploymentId)}
      </span>,
    },
    {
      key: "createdAt",
      header: "When",
      className: "whitespace-nowrap text-sm text-text-secondary",
      render: (entry) => (entry.createdAt ? new Date(entry.createdAt).toLocaleString() : "—"),
    },
    canPromote ? {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (entry) => <ActionMenu
        label={`Actions for ${HISTORY_REASON[entry.reason] ?? entry.reason} ${shortId(entry.toDeploymentId)}`}
        items={[
          { icon: RotateCcw, label: "Roll back to previous", disabled: busy || !entry.fromDeploymentId, onSelect: () => setRollbackTarget(entry) },
        ]}
      />,
    } : null,
  ].filter(Boolean);

  return <div className="space-y-6">
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-2 inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        All stages
      </button>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold text-foreground">{stage.name}</h3>
        {stage.autoDeploy ? <Badge variant="info">Auto-deploy</Badge> : null}
        {stage.canary ? <Badge variant="warning">Canary</Badge> : null}
      </div>
      <p className="mt-0.5 text-sm text-text-secondary">
        {stage.deploymentId ? <>Serving <span className="font-mono text-muted-foreground">{shortId(stage.deploymentId)}</span></> : "Not serving a deployment yet"}
        {stage.description ? <> · {stage.description}</> : null}
      </p>
      {stage.invokeUrl ? <div className="mt-1.5 flex min-w-0 items-center gap-1">
        <code className="min-w-0 truncate font-mono text-xs text-muted-foreground">{stage.invokeUrl}</code>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Copy ${stage.name} invoke URL`}
          className="shrink-0 text-text-secondary hover:bg-surface-active hover:text-foreground"
          onClick={() => copyInvokeUrl(stage.invokeUrl)}
        ><Copy className="size-4" /></Button>
      </div> : null}
    </div>

    <SegmentedTabs
      tabs={SUB_TABS}
      value={subTab}
      onChange={(key) => {
        setSubTab(key);
        if (key === "history") loadHistory();
      }}
    />

    {subTab === "settings" ? <SectionCard
      bare
      title="Stage variables"
      description="Key/value pairs available to integrations and mapping templates on this stage."
      action={can("pods.stage.write") ? <Button size="sm" className={PRIMARY} disabled={busy} onClick={saveVariables}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {busy ? "Saving…" : "Save Changes"}
      </Button> : null}
    >
      <Field label="Variables (JSON)" hint="Client certificates for this stage are managed under API Settings." htmlFor={`vars-${stage.id}`}>
        <Textarea
          id={`vars-${stage.id}`}
          className="min-h-32 font-mono text-xs"
          value={variablesText}
          onChange={(event) => setVariablesText(event.target.value)}
          readOnly={!can("pods.stage.write")}
          spellCheck={false}
        />
      </Field>
    </SectionCard> : null}
    {subTab === "canary" ? <CanaryTab api={api} stage={stage} onChanged={onChanged} /> : null}
    {subTab === "cache" ? <CacheTab api={api} stage={stage} onChanged={onChanged} /> : null}
    {subTab === "throttling" ? <StageThrottleTab api={api} stage={stage} /> : null}
    {subTab === "logging" ? <StageLoggingTab apiId={apiRef} stageName={stage.name} /> : null}
    {subTab === "history" ? <SectionCard
      bare
      title="Deployment history"
      description="Every time this stage moved to a different deployment."
      action={<Button size="sm" variant="outline" className={SECONDARY} disabled={history.status === "loading"} onClick={loadHistory}><History className="size-4" />Reload</Button>}
    >
      {history.status === "loading" ? <LoadingArea panel label="Loading history" /> : null}
      {history.status === "error" ? <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={History} title="History unavailable" description={history.error} action={<Button variant="outline" className={SECONDARY} onClick={loadHistory}>Retry</Button>} /></div> : null}
      {history.status === "ready" ? <DataTable
        columns={historyColumns}
        data={history.items}
        getRowKey={(entry) => entry.id}
        empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={History} title="No deployment changes yet" description="Deploys, rollbacks and canary promotions on this stage show up here." /></div>}
      /> : null}
    </SectionCard> : null}

    <Dialog open={Boolean(rollbackTarget)} onOpenChange={(next) => { if (!next) setRollbackTarget(null); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Roll back stage</DialogTitle>
          <DialogDescription>
            Point <span className="font-medium text-foreground">{stage.name}</span> back at deployment{" "}
            <span className="font-mono text-foreground">{shortId(rollbackTarget?.fromDeploymentId)}</span>? Live traffic switches immediately.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setRollbackTarget(null)}>Cancel</Button>
          <Button className="bg-red-500/90 text-white hover:bg-red-500" disabled={busy} onClick={() => rollback(rollbackTarget.fromDeploymentId)}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}Roll Back
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
