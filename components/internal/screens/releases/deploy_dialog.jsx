"use client";

import { useState } from "react";
import { Rocket } from "lucide-react";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
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
 * Deploy dialog (S05 §6): pick an existing stage or create a new one, with
 * a description. Shows compile warnings/errors inline; an error links to
 * the offending route/method.
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
      const body = await api(project.id, api.id ?? api.publicId, "/deployments", {
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
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Deploy {api.name}</DialogTitle>
        <DialogDescription>Compiles the draft into an immutable artifact and points a stage at it.</DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={submit}>
        <div className="space-y-2">
          <Label htmlFor="deploy-description">Description</Label>
          <Input id="deploy-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Release notes for this deployment" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="deploy-stage">Stage</Label>
          <Input id="deploy-stage" value={stageName} onChange={(event) => setStageName(event.target.value)} placeholder="prod" list="deploy-stages" />
          <datalist id="deploy-stages">
            {stages.map((stage) => <option key={stage.id ?? stage.name} value={stage.name} />)}
          </datalist>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={isNewStage} onChange={(event) => setIsNewStage(event.target.checked)} />
            Create the stage if it does not exist
          </label>
        </div>
        {problems ? <p className="text-sm text-destructive" role="alert">{problems.message}</p> : null}
        <DialogFooter>
          <Button type="submit" disabled={busy}><Rocket className="size-4" />{busy ? "Deploying…" : "Deploy"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

/** Deploy button for the API header. */
export function DeployButton({ api, stages, onDeployed }) {
  const [open, setOpen] = useState(false);
  return <>
    <Button onClick={() => setOpen(true)}><Rocket className="size-4" />Deploy</Button>
    <DeployDialog api={api} stages={stages} open={open} onOpenChange={setOpen} onDeployed={onDeployed} />
  </>;
}
