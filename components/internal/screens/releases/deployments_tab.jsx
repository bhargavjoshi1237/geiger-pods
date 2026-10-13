"use client";

import { useEffect, useState } from "react";
import { Copy, GitCompare, Loader2, Package, Rocket, X } from "lucide-react";
import { DataTable, EmptyState, LoadingArea, SectionCard } from "@/components/internal/shared/screen_kit";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { ListPagination, usePagination } from "@/components/internal/shared/pagination";

const PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";
const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

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

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? (value ?? "—") : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function copy(value, what) {
  navigator.clipboard?.writeText(value).then(
    () => toast.success(`${what} copied.`),
    () => toast.error(`Couldn't copy the ${what.toLowerCase()}.`),
  );
}

/**
 * Deployments tab: immutable revisions with the stages serving each one,
 * "deploy this revision to stage…" and compare.
 */
export function DeploymentsTab({ api, stages = [], onChanged }) {
  const { project } = useProject();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [comparing, setComparing] = useState([]);
  const [diff, setDiff] = useState(null);
  const [deployTarget, setDeployTarget] = useState(null);
  const [deploying, setDeploying] = useState(false);
  const pager = usePagination(state.items);

  useEffect(() => {
    let alive = true;
    call(project.id, api.id ?? api.publicId, "/deployments").then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id, api.id, api.publicId]);

  const refresh = async () => {
    setState({ status: "loading", items: [], error: null });
    try {
      const data = await call(project.id, api.id ?? api.publicId, "/deployments");
      setState({ status: "ready", items: data.items ?? [], error: null });
      onChanged?.();
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  };

  const deployToStage = async (deploymentId, stageName) => {
    setDeploying(true);
    try {
      await call(project.id, api.id ?? api.publicId, `/stages/${encodeURIComponent(stageName)}`, {
        method: "PATCH",
        body: JSON.stringify({ deploymentId }),
      });
      toast.success(`Deployed revision to ${stageName}.`);
      setDeployTarget(null);
      refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setDeploying(false);
    }
  };

  const compare = async (a, b) => {
    try {
      const data = await call(project.id, api.id ?? api.publicId, `/deployments/${encodeURIComponent(a)}/diff/${encodeURIComponent(b)}`);
      setDiff(data);
    } catch (error) {
      toast.error(error.message);
    }
  };

  const toggleCompare = (deploymentId) => setComparing((current) => {
    const next = current.includes(deploymentId) ? current.filter((id) => id !== deploymentId) : [...current, deploymentId].slice(-2);
    if (next.length === 2) compare(next[0], next[1]);
    return next;
  });

  const clearCompare = () => {
    setComparing([]);
    setDiff(null);
  };

  if (state.status === "loading") {
    return <LoadingArea panel label="Loading deployments" />;
  }
  if (state.status === "error") {
    return <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={Package} title="Deployments unavailable" description={state.error} action={<Button variant="outline" className={SECONDARY} onClick={refresh}>Retry</Button>} /></div>;
  }
  if (state.items.length === 0) {
    return <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={Rocket} title="No deployments yet" description="Use Deploy at the top of the page to snapshot the draft." /></div>;
  }

  const servingStages = (deployment) => stages.filter((stage) => stage.deploymentId === deployment.id || stage.canary?.deploymentId === deployment.id);

  const columns = [
    {
      key: "deployment",
      header: "Deployment",
      render: (deployment) => <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-foreground" title={deployment.id}>{shortId(deployment.id)}</span>
          {comparing.includes(deployment.id) ? <Badge variant="info"><GitCompare />Comparing</Badge> : null}
        </div>
        <p className="mt-0.5 font-mono text-xs text-text-tertiary" title={deployment.digest}>{String(deployment.digest ?? "").slice(0, 14)}</p>
      </div>,
    },
    {
      key: "description",
      header: "Description",
      className: "max-w-xs",
      render: (deployment) => deployment.description ? <span className="block max-w-[26rem] truncate text-sm text-foreground">{deployment.description}</span> : <span className="text-sm text-text-tertiary">No description</span>,
    },
    {
      key: "createdAt",
      header: "Created",
      className: "whitespace-nowrap text-sm text-text-secondary",
      render: (deployment) => formatDate(deployment.createdAt),
    },
    {
      key: "stages",
      header: "Serving",
      render: (deployment) => {
        const serving = servingStages(deployment);
        return serving.length ? <div className="flex flex-wrap gap-1">
          {serving.map((stage) => <Badge key={stage.id ?? stage.name} variant={stage.deploymentId === deployment.id ? "success" : "warning"}>
            {stage.name}{stage.deploymentId === deployment.id ? "" : " · canary"}
          </Badge>)}
        </div> : <span className="text-xs text-text-tertiary">—</span>;
      },
    },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (deployment) => <ActionMenu
        label={`Actions for deployment ${shortId(deployment.id)}`}
        items={[
          ...stages.map((stage) => ({
            icon: Rocket,
            label: `Deploy to ${stage.name}`,
            disabled: stage.deploymentId === deployment.id,
            onSelect: () => setDeployTarget({ deploymentId: deployment.id, stageName: stage.name }),
          })),
          { separator: true },
          { icon: GitCompare, label: comparing.includes(deployment.id) ? "Remove from comparison" : "Compare", onSelect: () => toggleCompare(deployment.id) },
          { icon: Copy, label: "Copy deployment ID", onSelect: () => copy(String(deployment.id), "Deployment ID") },
        ]}
      />,
    },
  ];

  return <div className="space-y-8">
    <div className="space-y-3">
      {comparing.length === 1 ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface-card px-4 py-3">
        <p className="text-sm text-text-secondary">Pick one more deployment to compare with <span className="font-mono text-foreground">{shortId(comparing[0])}</span>.</p>
        <Button variant="ghost" size="sm" className="text-text-secondary hover:bg-surface-active hover:text-foreground" onClick={clearCompare}>Cancel</Button>
      </div> : null}
      <DataTable columns={columns} data={pager.pageItems} getRowKey={(deployment) => deployment.id} />
      <ListPagination {...pager} itemLabel="deployments" />
    </div>

    {diff ? <SectionCard
      bare
      title="Changes"
      description={`${shortId(diff.deploymentIdA)} → ${shortId(diff.deploymentIdB)} · ${diff.changes.length} change${diff.changes.length === 1 ? "" : "s"}`}
      action={<Button size="sm" variant="outline" className={SECONDARY} onClick={clearCompare}><X className="size-4" />Clear</Button>}
    >
      {diff.changes.length ? <ul className="max-h-72 divide-y divide-border overflow-auto rounded-xl border border-border bg-surface-card font-mono text-xs">
        {diff.changes.slice(0, 50).map((change, index) => <li key={index} className="px-4 py-2.5">
          <p className="text-foreground">{change.path}</p>
          <p className="mt-0.5 break-all text-text-secondary"><span className="text-red-400">{JSON.stringify(change.before)}</span> → <span className="text-emerald-400">{JSON.stringify(change.after)}</span></p>
        </li>)}
      </ul> : <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={GitCompare} title="No differences" description="These deployments are identical." /></div>}
    </SectionCard> : null}

    <Dialog open={Boolean(deployTarget)} onOpenChange={(next) => { if (!next) setDeployTarget(null); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Deploy revision</DialogTitle>
          <DialogDescription>
            Point <span className="font-medium text-foreground">{deployTarget?.stageName}</span> at deployment{" "}
            <span className="font-mono text-foreground">{shortId(deployTarget?.deploymentId)}</span>? Live traffic on the stage switches immediately.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setDeployTarget(null)}>Cancel</Button>
          <Button className={PRIMARY} disabled={deploying} onClick={() => deployToStage(deployTarget.deploymentId, deployTarget.stageName)}>
            {deploying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}Deploy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
