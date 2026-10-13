"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowUpCircle, GitBranch, Loader2, Trash2 } from "lucide-react";
import { EmptyState, Field, LoadingArea, SectionCard, SettingRow, SettingsList } from "@/components/internal/shared/screen_kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Slider } from "@geiger/ui/slider";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";

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

function DeploymentCard({ label, deploymentId, share }) {
  return <div className="rounded-xl border border-border bg-surface-card px-4 py-3">
    <p className="text-xs text-text-secondary">{label}</p>
    <div className="mt-1 flex items-center justify-between gap-2">
      <span className="font-mono text-sm text-foreground" title={deploymentId ?? undefined}>{String(deploymentId ?? "—").slice(0, 8)}</span>
      <span className="text-xs tabular-nums text-text-secondary">{share}</span>
    </div>
  </div>;
}

/**
 * Stage canary: traffic share, variable overrides, stage-cache toggle,
 * base vs canary deployments, promote and delete.
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmPromote, setConfirmPromote] = useState(false);

  const refresh = useCallback(async () => {
    setState({ status: "loading", canary: null, error: null });
    try {
      const canary = await call(project.id, apiRef, `/stages/${encodeURIComponent(stage.name)}/canary`);
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
  }, [project.id, apiRef, stage.name]);

  useEffect(() => {
    let alive = true;
    call(project.id, apiRef, `/stages/${encodeURIComponent(stage.name)}/canary`).then(
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
  }, [project.id, apiRef, stage.name]);

  if (!can("pods.apis.view")) {
    return <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={GitBranch} title="Access unavailable" description="Your current team access does not allow this screen." /></div>;
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
      const canary = await call(project.id, apiRef, `/stages/${encodeURIComponent(stage.name)}/canary`, {
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
      await call(project.id, apiRef, `/stages/${encodeURIComponent(stage.name)}/canary/promote`, {
        method: "POST",
        body: JSON.stringify({ mergeVariables, removeCanary }),
      });
      toast.success("Canary promoted.");
      setConfirmPromote(false);
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
      await call(project.id, apiRef, `/stages/${encodeURIComponent(stage.name)}/canary`, { method: "DELETE" });
      setState({ status: "ready", canary: null, error: null });
      toast.success("Canary deleted; all traffic returns to the base deployment.");
      onChanged?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  if (state.status === "loading") return <LoadingArea panel label="Loading canary" />;
  const { canary } = state;
  const share = Number(percent) || 0;
  const canWrite = can("pods.stage.write");
  const canPromote = can("pods.stage.promote");

  return <div className="space-y-8">
    <SectionCard
      bare
      title="Canary release"
      description="Send a share of this stage's traffic to a second deployment. Canary traffic is reported separately in Monitoring."
      action={canary ? <Badge variant="warning">Active · {canary.percentTraffic ?? share}%</Badge> : null}
    >
      <div className="space-y-4">
        {canary ? <div className="grid gap-3 sm:grid-cols-2">
          <DeploymentCard label="Base deployment" deploymentId={stage.deploymentId} share={`${Math.round((100 - (canary.percentTraffic ?? share)) * 10) / 10}% of traffic`} />
          <DeploymentCard label="Canary deployment" deploymentId={canary.deploymentId} share={`${canary.percentTraffic ?? share}% of traffic`} />
        </div> : <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
          icon={GitBranch}
          title="No canary on this stage"
          description="Set a traffic share below to create one from the current deployment."
        /></div>}

        <div className="space-y-4 rounded-xl border border-border bg-surface-card p-4">
          <Field label="Traffic to canary" htmlFor={`canary-percent-${stage.id}`}>
            <div className="flex items-center gap-4">
              <Slider
                min={0}
                max={100}
                step={0.1}
                value={[share]}
                onValueChange={([value]) => setPercent(value)}
                aria-label="Traffic to canary"
                className="flex-1"
              />
              <div className="flex shrink-0 items-center gap-1.5">
                <Input
                  id={`canary-percent-${stage.id}`}
                  type="number" min={0} max={100} step={0.1} value={percent}
                  onChange={(event) => setPercent(event.target.value)}
                  className="w-20 text-right tabular-nums"
                />
                <span className="text-sm text-text-secondary">%</span>
              </div>
            </div>
          </Field>
          <div className="border-t border-border pt-4">
            <Field label="Stage variable overrides (JSON)" hint="Applied only to requests routed to the canary." htmlFor={`canary-overrides-${stage.id}`}>
              <Textarea
                id={`canary-overrides-${stage.id}`}
                className="min-h-24 font-mono text-xs"
                value={overridesText}
                onChange={(event) => setOverridesText(event.target.value)}
                spellCheck={false}
              />
            </Field>
          </div>
          <SettingsList className="border-t border-border pt-4">
            <SettingRow
              title="Use the stage cache"
              description="Let canary requests read from and write to the stage cache."
              checked={useStageCache}
              onCheckedChange={(value) => setUseStageCache(value === true)}
            />
          </SettingsList>
        </div>
        {canWrite ? <div className="flex justify-end">
          <Button size="sm" className={PRIMARY} disabled={busy} onClick={save}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {canary ? "Update Canary" : "Create Canary"}
          </Button>
        </div> : null}
      </div>
    </SectionCard>

    {canary ? <SectionCard bare title="Promote" description="Make the canary deployment the one this stage serves to everyone.">
      <div className="space-y-4">
        <div className="rounded-xl border border-border bg-surface-card p-4">
          <SettingsList>
            <SettingRow
              title="Merge variable overrides"
              description="Copy the canary's variable overrides into the stage variables."
              checked={mergeVariables}
              onCheckedChange={(value) => setMergeVariables(value === true)}
            />
            <SettingRow
              title="Remove the canary afterwards"
              description="Otherwise the canary stays in place with its traffic reset to 0%."
              checked={removeCanary}
              onCheckedChange={(value) => setRemoveCanary(value === true)}
            />
          </SettingsList>
        </div>
        {canWrite || canPromote ? <div className="flex flex-wrap justify-end gap-2">
          {canWrite ? <Button size="sm" variant="outline" className={SECONDARY} disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 className="size-4" />Delete Canary</Button> : null}
          {canPromote ? <Button size="sm" className={PRIMARY} disabled={busy} onClick={() => setConfirmPromote(true)}><ArrowUpCircle className="size-4" />Promote</Button> : null}
        </div> : null}
      </div>
    </SectionCard> : null}

    <Dialog open={confirmPromote} onOpenChange={setConfirmPromote}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Promote canary</DialogTitle>
          <DialogDescription>
            Serve the canary deployment to all traffic on <span className="font-medium text-foreground">{stage.name}</span>?{" "}
            {mergeVariables ? "Its variable overrides are merged into the stage variables" : "Stage variables stay as they are"}, and the canary is{" "}
            {removeCanary ? "removed" : "kept at 0% traffic"}.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setConfirmPromote(false)}>Cancel</Button>
          <Button className={PRIMARY} disabled={busy} onClick={promote}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpCircle className="h-4 w-4" />}Promote
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete canary</DialogTitle>
          <DialogDescription>Delete the canary on <span className="font-medium text-foreground">{stage.name}</span>? All traffic returns to the base deployment.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button className="bg-red-500/90 text-white hover:bg-red-500" disabled={busy} onClick={remove}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
