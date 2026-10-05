"use client";

import { useEffect, useState } from "react";
import { Package } from "lucide-react";
import { EmptyState, SectionCard } from "@geiger/ui/screen-kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";

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
 * Deployments tab (S05 §6): immutable list with digest prefix, description
 * and creator, plus "deploy this revision to stage…" and compare.
 */
export function DeploymentsTab({ api, stages = [], onChanged }) {
  const { project } = useProject();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [comparing, setComparing] = useState([]);
  const [diff, setDiff] = useState(null);

  useEffect(() => {
    let alive = true;
    api(project.id, api.id ?? api.publicId, "/deployments").then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, api.id, api.publicId]);

  const refresh = async () => {
    setState({ status: "loading", items: [], error: null });
    try {
      const data = await api(project.id, api.id ?? api.publicId, "/deployments");
      setState({ status: "ready", items: data.items ?? [], error: null });
      onChanged?.();
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  };

  const deployToStage = async (deploymentId, stageName) => {
    try {
      await api(project.id, api.id ?? api.publicId, `/stages/${encodeURIComponent(stageName)}`, {
        method: "PATCH",
        body: JSON.stringify({ deploymentId }),
      });
      toast.success(`Deployed revision to ${stageName}.`);
      refresh();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const compare = async (a, b) => {
    try {
      const data = await api(project.id, api.id ?? api.publicId, `/deployments/${encodeURIComponent(a)}/diff/${encodeURIComponent(b)}`);
      setDiff(data);
    } catch (error) {
      toast.error(error.message);
    }
  };

  if (state.status === "loading") {
    return <SectionCard><div className="flex justify-center py-10"><LogoLoading /></div></SectionCard>;
  }
  if (state.status === "error") {
    return <SectionCard><EmptyState icon={Package} title="Deployments unavailable" description={state.error} action={<Button variant="outline" onClick={refresh}>Retry</Button>} /></SectionCard>;
  }
  if (state.items.length === 0) {
    return <SectionCard><EmptyState icon={Package} title="No deployments yet" description="Deploy the draft to create the first immutable revision." /></SectionCard>;
  }
  return <SectionCard title="Deployments" description={`${state.items.length} immutable revision${state.items.length === 1 ? "" : "s"}.`}>
    <ul className="divide-y divide-border">
      {state.items.map((deployment) => <li key={deployment.id} className="flex flex-wrap items-center gap-3 py-4 first:pt-0 last:pb-0">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{deployment.description || "No description"}</p>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">{String(deployment.digest ?? "").slice(0, 14)}</Badge>
            <span>{deployment.createdAt}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={comparing.includes(deployment.id)}
              onChange={() => setComparing((current) => {
                const next = current.includes(deployment.id) ? current.filter((id) => id !== deployment.id) : [...current, deployment.id].slice(-2);
                if (next.length === 2) compare(next[0], next[1]);
                return next;
              })}
            />Compare
          </label>
          {stages.slice(0, 3).map((stage) => <Button
            key={stage.name}
            variant="outline"
            size="sm"
            onClick={() => deployToStage(deployment.id, stage.name)}
          >To {stage.name}</Button>)}
        </div>
      </li>)}
    </ul>
    {diff ? <div className="mt-4 border-t border-border pt-4 text-xs">
      <p className="font-medium">Diff: {String(diff.deploymentIdA).slice(0, 8)} → {String(diff.deploymentIdB).slice(0, 8)} ({diff.changes.length} changes)</p>
      <ul className="mt-2 max-h-48 space-y-1 overflow-auto font-mono">
        {diff.changes.slice(0, 50).map((change, index) => <li key={index}>{change.path}: {JSON.stringify(change.before)} → {JSON.stringify(change.after)}</li>)}
      </ul>
    </div> : null}
  </SectionCard>;
}
