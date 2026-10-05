"use client";

// Logs screen (S10 §9): access-log search (time, stage, status class, route,
// request id, source IP), live tail (2 s polling), and a request detail
// drawer combining the access line, execution log and trace waterfall.

import { useCallback, useEffect, useRef, useState } from "react";
import { LockKeyhole, ScrollText } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";

async function api(projectId, path) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/logs${path}`, {
    headers: { "content-type": "application/json" },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

function statusBadge(status) {
  if (status === null || status === undefined) return <Badge variant="outline">—</Badge>;
  if (status < 400) return <Badge variant="outline">{status}</Badge>;
  if (status < 500) return <Badge variant="secondary">{status}</Badge>;
  return <Badge variant="destructive">{status}</Badge>;
}

export function LogsScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [filters, setFilters] = useState({ stage: "", statusClass: "", route: "", requestId: "", sourceIp: "" });
  const [live, setLive] = useState(false);
  const [state, setState] = useState({ status: "idle", items: [], error: null });
  const [detail, setDetail] = useState(null);
  const timer = useRef(null);

  const search = useCallback(async (overrides = {}) => {
    const merged = { ...filters, ...overrides };
    setState({ status: "loading", items: [], error: null });
    try {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(merged)) {
        if (value) query.set(key, value);
      }
      query.set("limit", "50");
      const data = await api(project.id, `?${query.toString()}`);
      setState({ status: "ready", items: data.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [filters, project.id]);

  useEffect(() => {
    if (!live) {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      return undefined;
    }
    timer.current = setInterval(() => {
      void search().catch((error) => toast.error(error.message));
    }, 2000);
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [live, search]);

  useEffect(() => {
    let alive = true;
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value) query.set(key, value);
    }
    query.set("limit", "50");
    api(project.id, `?${query.toString()}`).then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id, filters]);

  const openDetail = useCallback(async (requestId) => {
    try {
      const data = await api(project.id, `/${encodeURIComponent(requestId)}`);
      setDetail({ requestId, ...data });
    } catch (error) {
      toast.error(error.message);
    }
  }, [project.id]);

  if (!can("pods.logs.view")) {
    return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
      <ScreenHeader title="Logs" description="Access and execution logs from live traffic." />
      <SectionCard><EmptyState icon={LockKeyhole} title="Access unavailable" description="Your current team access does not allow this screen." /></SectionCard>
    </div>;
  }

  return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
    <ScreenHeader
      title="Logs"
      description="Access-log search with live tail and per-request detail."
      actions={<div className="flex gap-2">
        <Button variant={live ? "default" : "outline"} onClick={() => setLive((value) => !value)}>{live ? "Stop tail" : "Live tail"}</Button>
        <Button variant="outline" onClick={() => search()}>Search</Button>
      </div>}
    />
    <SectionCard title="Search" description="Live tail polls every 2 s while enabled.">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[
          ["stage", "Stage"], ["statusClass", "Status class (2xx/4xx/5xx)"], ["route", "Route"],
          ["requestId", "Request id"], ["sourceIp", "Source IP"],
        ].map(([key, label]) => <div key={key} className="space-y-2">
          <Label htmlFor={`logs-${key}`}>{label}</Label>
          <Input id={`logs-${key}`} value={filters[key]} onChange={(event) => setFilters((prev) => ({ ...prev, [key]: event.target.value }))} />
        </div>)}
      </div>
    </SectionCard>
    {state.status === "loading" ? <SectionCard><div className="flex justify-center py-10"><LogoLoading /></div></SectionCard> : null}
    {state.status === "error" ? <SectionCard><EmptyState icon={ScrollText} title="Logs unavailable" description={state.error} action={<Button variant="outline" onClick={() => search()}>Retry</Button>} /></SectionCard> : null}
    {state.status === "ready" && state.items.length === 0 ? <SectionCard><EmptyState icon={ScrollText} title="No log lines yet" description="Lines appear here once the stage serves traffic with access logging enabled." /></SectionCard> : null}
    {state.status === "ready" && state.items.length > 0 ? <SectionCard title={`${state.items.length} lines`} description="Select a line for the access entry, execution log and trace waterfall.">
      <ul className="divide-y divide-border">
        {state.items.map((row) => <li key={`${row.request_id}-${row.ts}`} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
          {statusBadge(row.status)}
          <p className="min-w-0 flex-1 font-mono text-xs">{row.line}</p>
          <Button variant="outline" size="sm" onClick={() => openDetail(row.request_id)}>Details</Button>
        </li>)}
      </ul>
    </SectionCard> : null}
    {detail ? <SectionCard
      title={`Request ${detail.requestId}`}
      description={detail.bodiesRedacted ? "Request/response bodies are redacted — viewing them needs pods.logs.data." : "Access line, execution log and trace waterfall."}
      actions={<Button variant="outline" size="sm" onClick={() => setDetail(null)}>Close</Button>}
    >
      <div className="space-y-4">
        <div>
          <p className="text-sm font-medium">Access</p>
          <pre className="mt-1 overflow-x-auto rounded bg-muted p-3 font-mono text-xs">{(detail.access ?? []).map((row) => row.line).join("\n") || "No access line."}</pre>
        </div>
        <div>
          <p className="text-sm font-medium">Execution log</p>
          <pre className="mt-1 max-h-80 overflow-auto rounded bg-muted p-3 font-mono text-xs">{(detail.execution ?? []).flatMap((row) => row.lines ?? []).map((line) => `[${line.level}] ${line.message}`).join("\n") || "No execution log for this request."}</pre>
        </div>
        <div>
          <p className="text-sm font-medium">Trace waterfall</p>
          <pre className="mt-1 max-h-60 overflow-auto rounded bg-muted p-3 font-mono text-xs">{(detail.spans ?? []).map((span) => `${span.name} (${span.kind}): ${span.duration_ms ?? "?"} ms`).join("\n") || "Not sampled."}</pre>
        </div>
      </div>
    </SectionCard> : null}
  </div>;
}
