"use client";

import { useState } from "react";
import { AlertCircle, Loader2, Rocket } from "lucide-react";
import { Field, SettingRow, SettingsList } from "@/components/internal/shared/screen_kit";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
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

/**
 * Deploy dialog: pick an existing stage or name a new one, with a
 * description. Compile errors are shown inline.
 */
export function DeployDialog({ api, stages = [], open, onOpenChange, onDeployed }) {
  const { project } = useProject();
  const { can } = useRbac();
  const [description, setDescription] = useState("");
  const [stageName, setStageName] = useState(stages[0]?.name ?? "prod");
  const [isNewStage, setIsNewStage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState(null);
  const writable = can("pods.deployment.create");

  if (!writable) return null;

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setProblems(null);
    try {
      const body = await call(project.id, api.id ?? api.publicId, "/deployments", {
        method: "POST",
        body: JSON.stringify({ description, stageName: stageName.trim() || null }),
      });
      toast.success(`Deployed ${body.digest?.slice(0, 12) ?? ""} to ${body.stage ?? stageName}.`);
      onOpenChange(false);
      onDeployed?.(body);
    } catch (error) {
      setProblems({ message: error.message });
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-xl bg-background">
      <DialogHeader>
        <DialogTitle>Deploy {api.name}</DialogTitle>
        <DialogDescription>Snapshot the current draft into an immutable deployment and point a stage at it.</DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={submit}>
        <Field label="Description" hint="Optional release notes shown in the deployments list." htmlFor="deploy-description">
          <Input id="deploy-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What changed in this release" />
        </Field>
        <Field label="Stage" hint={stages.length ? "Pick an existing stage or type a new name." : "Name the stage this deployment will serve."} htmlFor="deploy-stage">
          <Input id="deploy-stage" className="font-mono" value={stageName} onChange={(event) => setStageName(event.target.value)} placeholder="prod" list="deploy-stages" />
          <datalist id="deploy-stages">
            {stages.map((stage) => <option key={stage.id ?? stage.name} value={stage.name} />)}
          </datalist>
        </Field>
        <SettingsList className="rounded-xl border border-border bg-surface-card p-4">
          <SettingRow
            title="Create the stage if it doesn't exist"
            description="A new stage starts out serving this deployment."
            checked={isNewStage}
            onCheckedChange={(value) => setIsNewStage(value === true)}
          />
        </SettingsList>
        {problems ? <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-words">{problems.message}</span>
        </div> : null}
        <DialogFooter>
          <Button type="button" variant="outline" className={SECONDARY} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" className={PRIMARY} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="size-4" />}{busy ? "Deploying…" : "Deploy"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

/** Deploy button for the API header. */
export function DeployButton({ api, stages, onDeployed }) {
  const [open, setOpen] = useState(false);
  return <>
    <Button className={PRIMARY} onClick={() => setOpen(true)}><Rocket className="size-4" />Deploy</Button>
    <DeployDialog api={api} stages={stages} open={open} onOpenChange={setOpen} onDeployed={onDeployed} />
  </>;
}
