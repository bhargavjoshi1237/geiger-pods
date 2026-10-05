"use client";

// Audit trail UI (S10 §8, CloudTrail equivalent, `/audit`): filter by actor,
// action, resource type/id, API and time. Each entry shows a before/after
// JSON diff (already redacted server-side by S02). Export CSV.

import { useCallback, useEffect, useState } from "react";
import { Download, ScrollText } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";

async function api(projectId, path) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/audit${path}`, {
    headers: { "content-type": "application/json" },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

function DiffView({ before, after }) {
  if (!before && !after) return <p className="text-xs text-muted-foreground">No recorded change.</p>;
  return <div className="grid gap-2 lg:grid-cols-2">
    <div>
      <p className="text-xs font-medium">Before</p>
      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">{JSON.stringify(before ?? null, null, 2)}</pre>
    </div>
    <div>
      <p className="text-xs font-medium">After</p>
      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">{JSON.stringify(after ?? null, null, 2)}</pre>
    </div>
  </div>;
}

export function AuditScreen() {
  const { project } = useProject();
  const [filters, setFilters] = useState({ actor: "", action: "", resourceType: "", resourceId: "", apiId: "", from: "", to: "" });
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [expanded, setExpanded] = useState(null);

  const search = useCallback(async () => {
    setState({ status: "loading", items: [], error: null });
    try {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) {
        if (value) query.set(key, value);
      }
      query.set("limit", "50");
      const data = await api(project.id, query.toString() === "" ? "" : `?${query.toString()}`);
      setState({ status: "ready", items: data.items ?? data ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [filters, project.id]);

  useEffect(() => {
    let alive = true;
    api(project.id, "?limit=50").then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? data ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id]);

  const exportCsv = () => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value) query.set(key, value);
    }
    const anchor = document.createElement("a");
    anchor.href = `/api/v1/projects/${encodeURIComponent(project.id)}/audit/export${query.toString() === "" ? "" : `?${query.toString()}`}`;
    anchor.download = `audit-${project.id}.csv`;
    anchor.click();
  };

  const set = (key) => (event) => setFilters((current) => ({ ...current, [key]: event.target.value }));

  return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
    <ScreenHeader
      title="Audit"
      description="Every management change, newest first. Sensitive values are redacted at write time."
      actions={<div className="flex gap-2">
        <Button variant="outline" onClick={() => search()}>Search</Button>
        <Button variant="outline" onClick={exportCsv}><Download className="size-4" />Export CSV</Button>
      </div>}
    />
    <SectionCard title="Filters" description="Retention is unlimited by default; a project setting can lower it to ≥ 90 days.">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[["actor", "Actor"], ["action", "Action (deployment.create)"], ["resourceType", "Resource type"], ["resourceId", "Resource id"], ["apiId", "API id"]].map(([key, label]) => <div key={key} className="space-y-2">
          <Label htmlFor={`audit-${key}`}>{label}</Label>
          <Input id={`audit-${key}`} value={filters[key]} onChange={set(key)} spellCheck={false} className="font-mono text-xs" />
        </div>)}
        <div className="space-y-2">
          <Label htmlFor="audit-from">From</Label>
          <Input id="audit-from" type="date" value={filters.from} onChange={set("from")} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="audit-to">To</Label>
          <Input id="audit-to" type="date" value={filters.to} onChange={set("to")} />
        </div>
      </div>
    </SectionCard>
    {state.status === "loading" ? <SectionCard><div className="flex justify-center py-10"><LogoLoading /></div></SectionCard> : null}
    {state.status === "error" ? <SectionCard><EmptyState icon={ScrollText} title="Audit unavailable" description={state.error} action={<Button variant="outline" onClick={() => search().catch((error) => toast.error(error.message))}>Retry</Button>} /></SectionCard> : null}
    {state.status === "ready" && state.items.length === 0 ? <SectionCard><EmptyState icon={ScrollText} title="No audit entries" description="Management changes appear here once someone creates or edits a resource." /></SectionCard> : null}
    {state.status === "ready" && state.items.length > 0 ? <SectionCard title={`${state.items.length} entries`} description="Select an entry for its before/after diff.">
      <ul className="divide-y divide-border">
        {state.items.map((entry) => {
          const id = entry.id ?? `${entry.created_at}-${entry.action}`;
          return <li key={id} className="py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="outline">{entry.action ?? entry.action_type ?? "unknown"}</Badge>
              <span className="font-mono text-muted-foreground">{entry.resource_type ?? entry.resourceType}{entry.resource_id ?? entry.resourceId ? ` ${entry.resource_id ?? entry.resourceId}` : ""}</span>
              <span className="text-muted-foreground">{entry.created_at ?? entry.createdAt ?? ""}</span>
              <span className="flex-1" />
              <Button variant="outline" size="sm" onClick={() => setExpanded(expanded === id ? null : id)}>{expanded === id ? "Hide diff" : "Diff"}</Button>
            </div>
            {expanded === id ? <div className="pt-2"><DiffView before={entry.before} after={entry.after} /></div> : null}
          </li>;
        })}
      </ul>
    </SectionCard> : null}
  </div>;
}
