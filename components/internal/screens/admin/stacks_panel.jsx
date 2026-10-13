"use client";

// Stacks: plan preview with ordered operations, apply, and drift status for a
// declarative stack file. There is no stored list of stacks to browse, so the
// screen edits one stack file at a time.

import { useState } from "react";
import { FileDiff, Layers, Loader2, LockKeyhole, Play, ScanSearch } from "lucide-react";
import { DataTable, EmptyState, Field, LoadingArea, ScreenHeader, SectionCard, StatusPill } from "@/components/internal/shared/screen_kit";
import { MainScreenWrapper } from "@/components/internal/shared/screen_wrappers";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";

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

const OP_MAP = {
  create: { label: "Create", variant: "success" },
  update: { label: "Update", variant: "info" },
  delete: { label: "Delete", variant: "danger" },
};

const SYNC_MAP = {
  inSync: { label: "In sync", variant: "success" },
  drift: { label: "Drift detected", variant: "warning" },
};

const RESULT_TITLE = { plan: "Plan", apply: "Apply Result", drift: "Drift Check" };

const formatDateTime = (value) => (value ? new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—");

const outlineQuiet = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

const columns = [
  { key: "kind", header: "Kind", render: (change) => <Badge variant="outline">{change.kind}</Badge> },
  { key: "name", header: "Resource", render: (change) => <span className="font-mono text-xs text-foreground">{change.name}</span> },
  {
    key: "op",
    header: "Operation",
    render: (change) => <div className="flex flex-wrap items-center gap-2">
      <StatusPill status={change.op} map={OP_MAP} />
      {change.skipped ? <Badge variant="neutral">Skipped: {change.skipped === "needs_prune" ? "needs prune" : change.skipped}</Badge> : null}
    </div>,
  },
  {
    key: "fields",
    header: "Changes",
    render: (change) => {
      const fields = change.op === "update" ? Object.keys(change.diff ?? {}) : [];
      return <span className="text-sm text-text-secondary">{fields.length ? fields.join(", ") : "—"}</span>;
    },
  },
];

function ResultBody({ result }) {
  const { action, data } = result;
  const changes = data.changes ?? data.applied ?? [];
  return <div className="space-y-4">
    {action === "drift" ? <dl className="grid gap-4 sm:grid-cols-2">
      {[
        ["Status", <StatusPill key="sync" status={data.inSync ? "inSync" : "drift"} map={SYNC_MAP} />],
        ["Last apply", data.status ?? "idle"],
        ["Last applied", formatDateTime(data.lastAppliedAt)],
        ["File hash", <span key="hash" className="break-all font-mono text-xs">{data.fileHash ?? "—"}</span>],
      ].map(([label, value]) => <div key={label}>
        <dt className="text-xs text-text-secondary">{label}</dt>
        <dd className="mt-1 text-sm text-foreground">{value}</dd>
      </div>)}
    </dl> : null}
    <DataTable
      columns={columns}
      data={changes}
      getRowKey={(change, index) => `${change.kind}:${change.name}:${index}`}
      empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
        icon={FileDiff}
        title={action === "apply" ? "Nothing applied" : "No changes"}
        description={action === "apply" ? "Live resources already matched the stack file." : "The stack matches the desired state."}
      /></div>}
    />
  </div>;
}

export function StacksPanel() {
  const { project } = useProject();
  const { can } = useRbac();
  const [name, setName] = useState("payments");
  const [text, setText] = useState('{"version":1,"stack":"payments","apis":[]}');
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const writable = can("pods.api.create");

  const run = async (action) => {
    if (!name.trim()) {
      toast.error("Give the stack a name first.");
      return;
    }
    let file;
    try {
      file = JSON.parse(text);
    } catch {
      toast.error("Stack file must be valid JSON (YAML parsed client-side).");
      return;
    }
    setBusy(action);
    try {
      const data = await callStack(project.id, name, action, file, false);
      setResult({ action, data });
      if (action === "apply") toast.success(`Applied "${name}".`);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(null);
    }
  };

  const spinner = (action, Icon) => (busy === action ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />);

  return <MainScreenWrapper>
    <ScreenHeader
      title="Stacks"
      description="Declarative configuration for this project: preview a plan, apply it, and check live resources for drift."
      actions={writable ? <>
        <Button variant="outline" className={outlineQuiet} disabled={!!busy} onClick={() => run("drift")}>{spinner("drift", ScanSearch)}Check Drift</Button>
        <Button variant="outline" className={outlineQuiet} disabled={!!busy} onClick={() => run("plan")}>{spinner("plan", FileDiff)}Plan</Button>
        <Button className="bg-primary text-primary-foreground hover:bg-primary/90" disabled={!!busy} onClick={() => run("apply")}>{spinner("apply", Play)}Apply</Button>
      </> : null}
    />

    {!writable ? <div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface-card px-3.5 py-2.5 text-xs leading-relaxed text-text-secondary">
      <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-tertiary" />
      <p>Planning and applying stacks needs the <span className="text-foreground">Create APIs</span> permission.</p>
    </div> : null}

    <div className="space-y-6">
      <SectionCard title="Stack file" description="Paste the JSON form of pods.yaml. Secret values are never accepted here.">
        <div className="grid gap-4">
          <Field label="Stack name" htmlFor="stack-name" hint="Must match the stack named inside the file." className="sm:max-w-xs">
            <Input id="stack-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="payments" spellCheck={false} className="font-mono text-xs" />
          </Field>
          <Field label="Definition" htmlFor="stack-file">
            <Textarea id="stack-file" rows={12} value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} className="font-mono text-xs" />
          </Field>
        </div>
      </SectionCard>

      {busy ? <LoadingArea panel label="Running stack operation" /> : result ? <SectionCard
        title={RESULT_TITLE[result.action] ?? result.action}
        description={result.action === "plan"
          ? "Operations run in this order on apply. Deletes are skipped unless pruning."
          : result.action === "apply"
            ? "Operations applied to live resources."
            : "Differences between live resources and this file."}
      >
        <ResultBody result={result} />
      </SectionCard> : <div className="rounded-xl border border-border bg-surface-subtle">
        <EmptyState icon={Layers} title="No plan yet" description="Plan the stack file to preview its changes before you apply it." />
      </div>}
    </div>
  </MainScreenWrapper>;
}
