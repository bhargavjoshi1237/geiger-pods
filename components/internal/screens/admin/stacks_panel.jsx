"use client";

// Stacks panel (S14 §4): plan preview with ordered operations, apply with
// prune toggle, and drift status. Standalone: the orchestrator mounts it
// under project administration.

import { useState } from "react";
import { FileDiff, Play } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";

async function callStack(projectId, stack, action, file, prune) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/stacks/${encodeURIComponent(stack)}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file, prune }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

export function StacksPanel() {
  const { project } = useProject();
  const [name, setName] = useState("payments");
  const [text, setText] = useState('{"version":1,"stack":"payments","apis":[]}');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const run = async (action) => {
    let file;
    try {
      file = JSON.parse(text);
    } catch {
      toast.error("Stack file must be valid JSON (YAML parsed client-side).");
      return;
    }
    setBusy(true);
    try {
      const data = await callStack(project.id, name, action, file, false);
      setResult({ action, data });
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
    <ScreenHeader
      title="Stacks"
      description="Declarative configuration: plan, apply and drift for pods.yaml."
      actions={<div className="flex gap-2">
        <Button variant="outline" disabled={busy} onClick={() => run("plan")}><FileDiff className="size-4" />Plan</Button>
        <Button variant="outline" disabled={busy} onClick={() => run("drift")}>Drift</Button>
        <Button disabled={busy} onClick={() => run("apply")}><Play className="size-4" />Apply</Button>
      </div>}
    />
    <SectionCard title="Stack file" description="Paste the JSON form of pods.yaml. Secret values are never accepted here.">
      <div className="space-y-3">
        <input
          className="w-64 rounded-md border border-input bg-background px-3 py-2 text-sm"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Stack name"
          aria-label="Stack name"
        />
        <Textarea rows={10} value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} className="font-mono text-xs" />
      </div>
    </SectionCard>
    {busy ? <SectionCard><div className="flex justify-center py-6"><LogoLoading /></div></SectionCard> : null}
    {result ? <SectionCard title={`${result.action} result`}>
      {result.action === "plan" && (result.data.changes ?? []).length === 0 ? <EmptyState icon={FileDiff} title="No changes" description="The stack matches the desired state." /> : null}
      <ul className="divide-y divide-border">
        {(result.data.changes ?? result.data.applied ?? []).map((change, index) => <li key={index} className="flex flex-wrap items-center gap-2 py-2 first:pt-0 last:pb-0">
          <Badge variant="outline">{change.kind}</Badge>
          <span className="font-mono text-xs">{change.name}</span>
          <Badge variant="outline">{change.op}{change.skipped ? ` (${change.skipped})` : ""}</Badge>
        </li>)}
      </ul>
      {result.data.inSync !== undefined ? <p className="mt-2 text-sm text-muted-foreground">{result.data.inSync ? "In sync." : "Drift detected."}</p> : null}
    </SectionCard> : null}
  </div>;
}
