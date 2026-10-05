"use client";

import { useCallback, useEffect, useState } from "react";
import { History, Layers } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";

async function api(projectId, apiId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/apis/${encodeURIComponent(apiId)}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

/**
 * Stages tab (S05 §6): list (name, deployed revision, deployed at/by,
 * invoke URL with copy, auto-deploy badge, canary badge). Stage detail
 * sub-tabs: Settings (description, variables editor, client certificate),
 * Throttling (S08), Logs & tracing (S10), Cache (S09), Canary (S09),
 * History (pointer changes with rollback + diff viewer).
 */
export function StagesTab({ api }) {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [selected, setSelected] = useState(null);

  const refresh = useCallback(async () => {
    setState({ status: "loading", items: [], error: null });
    try {
      const data = await api(project.id, api.id ?? api.publicId, "/stages");
      setState({ status: "ready", items: data.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, api.id, api.publicId]);

  useEffect(() => {
    let alive = true;
    api(project.id, api.id ?? api.publicId, "/stages").then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, api.id, api.publicId]);

  if (state.status === "loading") {
    return <SectionCard><div className="flex justify-center py-10"><LogoLoading /></div></SectionCard>;
  }
  if (state.status === "error") {
    return <SectionCard><EmptyState icon={Layers} title="Stages unavailable" description={state.error} action={<Button variant="outline" onClick={refresh}>Retry</Button>} /></SectionCard>;
  }
  if (state.items.length === 0) {
    return <SectionCard><EmptyState icon={Layers} title="No stages yet" description="Deploy the API to create the first stage. Stages are immutable pointers at deployments." /></SectionCard>;
  }
  return <div className="space-y-4">
    {state.items.map((stage) => <SectionCard
      key={stage.id}
      title={stage.name}
      description={stage.description || "No description."}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {stage.deploymentId ? <Badge variant="outline">{String(stage.deploymentId).slice(0, 8)}</Badge> : <Badge variant="outline">unpointed</Badge>}
        {stage.autoDeploy ? <Badge>auto-deploy</Badge> : null}
        {stage.canary ? <Badge variant="secondary">canary</Badge> : null}
        {stage.invokeUrl ? <code className="truncate">{stage.invokeUrl}</code> : null}
        {stage.invokeUrl ? <Button
          variant="outline"
          size="sm"
          onClick={() => {
            navigator.clipboard?.writeText(stage.invokeUrl).then(
              () => toast.success("Invoke URL copied."),
              () => toast.error("Copy failed."),
            );
          }}
        >Copy URL</Button> : null}
        <Button variant="outline" size="sm" onClick={() => setSelected(stage)}>Details</Button>
      </div>
      {selected?.id === stage.id ? <StageDetail api={api} stage={stage} onClose={() => setSelected(null)} onChanged={refresh} can={can} projectId={project.id} /> : null}
    </SectionCard>)}
  </div>;
}

function StageDetail({ api, stage, onClose, onChanged, can, projectId }) {
  const [variablesText, setVariablesText] = useState(JSON.stringify(stage.variables ?? {}, null, 2));
  const [history, setHistory] = useState({ status: "idle", items: [] });
  const [busy, setBusy] = useState(false);

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
      await api(projectId, api.id ?? api.publicId, `/stages/${encodeURIComponent(stage.name)}`, {
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

  const loadHistory = async () => {
    setHistory({ status: "loading", items: [] });
    try {
      const data = await api(projectId, api.id ?? api.publicId, `/stages/${encodeURIComponent(stage.name)}/history`);
      setHistory({ status: "ready", items: data.items ?? [] });
    } catch (error) {
      setHistory({ status: "error", items: [], error: error.message });
    }
  };

  const rollback = async (deploymentId) => {
    if (!can("pods.stage.promote")) {
      toast.error("Your current team access does not allow promoting.");
      return;
    }
    setBusy(true);
    try {
      await api(projectId, api.id ?? api.publicId, `/stages/${encodeURIComponent(stage.name)}/rollback`, {
        method: "POST",
        body: JSON.stringify({ deploymentId }),
      });
      toast.success(`Rolled back ${stage.name}.`);
      onChanged();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <div className="mt-4 space-y-4 border-t border-border pt-4">
    <div className="space-y-2">
      <Label htmlFor={`vars-${stage.id}`}>Stage variables (JSON)</Label>
      <textarea
        id={`vars-${stage.id}`}
        className="min-h-24 w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
        value={variablesText}
        onChange={(event) => setVariablesText(event.target.value)}
        spellCheck={false}
      />
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={busy || !can("pods.stage.write")} onClick={saveVariables}>Save variables</Button>
        <Button variant="outline" size="sm" onClick={loadHistory}><History className="size-4" />History</Button>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </div>
    </div>
    {history.status === "ready" ? <ul className="space-y-2 text-xs">
      {history.items.map((entry) => <li key={entry.id} className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{entry.reason}</Badge>
        <span>{String(entry.fromDeploymentId ?? "—").slice(0, 8)} → {String(entry.toDeploymentId ?? "—").slice(0, 8)}</span>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => rollback(entry.fromDeploymentId)}>Rollback to previous</Button>
      </li>)}
      {history.items.length === 0 ? <li className="text-muted-foreground">No pointer changes yet.</li> : null}
    </ul> : null}
  </div>;
}
