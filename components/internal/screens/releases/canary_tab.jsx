"use client";

import { useCallback, useEffect, useState } from "react";
import { GitBranch } from "lucide-react";
import { EmptyState, SectionCard } from "@geiger/ui/screen-kit";
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
 * Stage → Canary sub-tab (S09 §1 + §4): create canary, traffic slider
 * (0–100, 0.1 steps), variable overrides, use-stage-cache toggle, current
 * canary vs base deployments, Promote (merge-variables checkbox,
 * remove-or-reset choice) and Delete canary. A live split chart would read
 * S10 metrics (`{stage}/Canary` dimension); until the monitoring tab embeds
 * it, this links there.
 *
 * @param {{ api: object, stage: object, onChanged?: () => void }} props
 */
export function CanaryTab({ api, stage, onChanged }) {
  const { project } = useProject();
  const { can } = useRbac();
  const apiRef = api.id ?? api.publicId;
  const [state, setState] = useState({ status: "loading", canary: null, error: null });
  const [percent, setPercent] = useState(10);
  const [overridesText, setOverridesText] = useState("{}");
  const [useStageCache, setUseStageCache] = useState(false);
  const [mergeVariables, setMergeVariables] = useState(true);
  const [removeCanary, setRemoveCanary] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setState({ status: "loading", canary: null, error: null });
    try {
      const canary = await api(project.id, apiRef, `/stages/${encodeURIComponent(stage.name)}/canary`);
      setState({ status: "ready", canary, error: null });
      if (canary) {
        setPercent(canary.percentTraffic ?? 10);
        setOverridesText(JSON.stringify(canary.stageVariableOverrides ?? {}, null, 2));
        setUseStageCache(Boolean(canary.useStageCache));
      }
    } catch (error) {
      setState({ status: "ready", canary: null, error: null });
      void error;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, apiRef, stage.name]);

  useEffect(() => {
    let alive = true;
    api(project.id, apiRef, `/stages/${encodeURIComponent(stage.name)}/canary`).then(
      (canary) => {
        if (!alive) return;
        setState({ status: "ready", canary, error: null });
        if (canary) {
          setPercent(canary.percentTraffic ?? 10);
          setOverridesText(JSON.stringify(canary.stageVariableOverrides ?? {}, null, 2));
          setUseStageCache(Boolean(canary.useStageCache));
        }
      },
      () => { if (alive) setState({ status: "ready", canary: null, error: null }); },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, apiRef, stage.name]);

  if (!can("pods.apis.view")) {
    return <EmptyState icon={GitBranch} title="Access unavailable" description="Your current team access does not allow this screen." />;
  }

  async function save() {
    let overrides = {};
    try {
      overrides = JSON.parse(overridesText || "{}");
    } catch {
      toast.error("Stage variable overrides must be valid JSON.");
      return;
    }
    setBusy(true);
    try {
      const canary = await api(project.id, apiRef, `/stages/${encodeURIComponent(stage.name)}/canary`, {
        method: "PUT",
        body: JSON.stringify({ percentTraffic: Number(percent), stageVariableOverrides: overrides, useStageCache }),
      });
      setState({ status: "ready", canary, error: null });
      toast.success(`Canary set to ${canary.percentTraffic}%.`);
      onChanged?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function promote() {
    setBusy(true);
    try {
      await api(project.id, apiRef, `/stages/${encodeURIComponent(stage.name)}/canary/promote`, {
        method: "POST",
        body: JSON.stringify({ mergeVariables, removeCanary }),
      });
      toast.success("Canary promoted.");
      await refresh();
      onChanged?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api(project.id, apiRef, `/stages/${encodeURIComponent(stage.name)}/canary`, { method: "DELETE" });
      setState({ status: "ready", canary: null, error: null });
      toast.success("Canary deleted; all traffic returns to the base deployment.");
      onChanged?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  if (state.status === "loading") return <LogoLoading label="Loading canary…" />;
  const { canary } = state;

  return <div className="space-y-4">
    <SectionCard title="Canary release" description="Send a percentage of stage traffic to a second deployment. Metrics split under {stage}/Canary (see Monitoring).">
      {canary ? <dl className="grid grid-cols-2 gap-2 text-xs">
        <dt className="text-muted-foreground">Base deployment</dt><dd className="font-mono">{String(stage.deploymentId ?? "—").slice(0, 8)}</dd>
        <dt className="text-muted-foreground">Canary deployment</dt><dd className="font-mono">{String(canary.deploymentId ?? "—").slice(0, 8)}</dd>
      </dl> : <p className="text-xs text-muted-foreground">No canary on this stage. Set a percentage below to create one from the current deployment.</p>}
      <div className="space-y-2">
        <Label htmlFor={`canary-percent-${stage.id}`}>Traffic to canary: {percent}%</Label>
        <Input
          id={`canary-percent-${stage.id}`}
          type="range" min={0} max={100} step={0.1} value={percent}
          onChange={(event) => setPercent(event.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`canary-overrides-${stage.id}`}>Stage variable overrides (JSON)</Label>
        <textarea
          id={`canary-overrides-${stage.id}`}
          className="min-h-20 w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
          value={overridesText}
          onChange={(event) => setOverridesText(event.target.value)}
          spellCheck={false}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={useStageCache} onChange={(event) => setUseStageCache(event.target.checked)} />
        Canary uses the stage cache
      </label>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || !can("pods.stage.write")} onClick={save}>{canary ? "Update canary" : "Create canary"}</Button>
        {canary ? <>
          <Button variant="outline" size="sm" disabled={busy || !can("pods.stage.promote")} onClick={promote}>Promote</Button>
          <Button variant="ghost" size="sm" disabled={busy || !can("pods.stage.write")} onClick={remove}>Delete canary</Button>
        </> : null}
      </div>
      {canary ? <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={mergeVariables} onChange={(event) => setMergeVariables(event.target.checked)} />
          Merge overrides into stage variables on promote
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={removeCanary} onChange={(event) => setRemoveCanary(event.target.checked)} />
          Remove canary after promote (otherwise reset to 0%)
        </label>
      </div> : null}
    </SectionCard>
  </div>;
}
