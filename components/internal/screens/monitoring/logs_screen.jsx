"use client";

// Logs: access-log search (stage, status class, request id / route / source
// IP), live tail (2 s polling) and a per-request page combining the access
// line, execution log and trace waterfall. The open request lives in
// `?record=` so back/forward close and reopen it.

import { useEffect, useMemo, useState } from "react";
import { Copy, ExternalLink, LockKeyhole, RefreshCw, ScrollText } from "lucide-react";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { cn } from "@geiger/ui/lib/utils";
import { toast } from "sonner";
import { DataTable, EmptyState, LoadingArea, ScreenHeader, SearchInput, SectionCard, StatusPill, Toolbar } from "@/components/internal/shared/screen_kit";
import { MainScreenWrapper, SecondaryScreenWrapper } from "@/components/internal/shared/screen_wrappers";
import { ListPagination, usePagination } from "@/components/internal/shared/pagination";
import { EditorHeader } from "@/components/internal/shared/editor_shell";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { useRecordParam } from "@/lib/hooks/use-record-param";
import FilterDropdown from "../overview/filter_dropdown";

const SECONDARY = "h-9 border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";
const ALL = "all";

const STATUS_CLASS_OPTIONS = [
  { value: ALL, label: "All statuses" },
  { value: "2xx", label: "2xx success" },
  { value: "4xx", label: "4xx client errors" },
  { value: "5xx", label: "5xx server errors" },
];

const SEARCH_FIELDS = [
  { value: "requestId", label: "Request ID", placeholder: "Search by request ID…" },
  { value: "route", label: "Route", placeholder: "Search by route…" },
  { value: "sourceIp", label: "Source IP", placeholder: "Search by source IP…" },
];

const STATUS_META = {
  "2xx": { variant: "success", dotClass: "bg-emerald-400" },
  "3xx": { variant: "info", dotClass: "bg-sky-400" },
  "4xx": { variant: "warning", dotClass: "bg-amber-400" },
  "5xx": { variant: "danger", dotClass: "bg-red-400" },
};

async function api(projectId, path) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/logs${path}`, {
    headers: { "content-type": "application/json" },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

function statusMapFor(status) {
  if (status === null || status === undefined) return {};
  const meta = STATUS_META[`${String(status)[0]}xx`] ?? { variant: "neutral" };
  return { [status]: meta };
}

function RequestStatus({ status }) {
  if (status === null || status === undefined) return <span className="text-sm text-text-secondary">—</span>;
  return <StatusPill status={status} map={statusMapFor(status)} />;
}

const formatTime = (value) => (value
  ? new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" })
  : "—");

function copy(value) {
  navigator.clipboard?.writeText(value).then(
    () => toast.success("Copied."),
    () => toast.error("Couldn't copy to the clipboard."),
  );
}

export function LogsScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [recordId, setRecordId] = useRecordParam();
  const [statusClass, setStatusClass] = useState(ALL);
  const [stage, setStage] = useState(ALL);
  const [searchField, setSearchField] = useState("requestId");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [live, setLive] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [knownStages, setKnownStages] = useState([]);
  const [state, setState] = useState({ key: null, status: "loading", items: [], error: null });
  const allowed = can("pods.logs.view");

  // Exact-match server filters: wait for the user to stop typing.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 400);
    return () => clearTimeout(timer);
  }, [search]);

  const filters = useMemo(() => ({
    stage: stage === ALL ? "" : stage,
    statusClass: statusClass === ALL ? "" : statusClass,
    route: searchField === "route" ? query : "",
    requestId: searchField === "requestId" ? query : "",
    sourceIp: searchField === "sourceIp" ? query : "",
  }), [stage, statusClass, searchField, query]);
  const filterKey = `${JSON.stringify(filters)}|${nonce}`;

  useEffect(() => {
    if (!allowed || recordId) return undefined;
    let alive = true;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value) params.set(key, value);
    }
    params.set("limit", "50");
    const load = () => api(project.id, `?${params.toString()}`).then(
      (data) => {
        if (!alive) return;
        const items = data.items ?? [];
        setState({ key: filterKey, status: "ready", items, error: null });
        const seen = items.map((row) => row.stage).filter(Boolean);
        setKnownStages((prev) => (seen.every((name) => prev.includes(name)) ? prev : [...new Set([...prev, ...seen])].sort()));
      },
      (error) => { if (alive) setState({ key: filterKey, status: "error", items: [], error: error.message }); },
    );
    load();
    const timer = live ? setInterval(load, 2000) : null;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [allowed, recordId, project.id, filters, filterKey, live]);

  const items = state.items;
  const pager = usePagination(items, { resetKey: filterKey.replace(/\|\d+$/, "") });

  const stageOptions = useMemo(() => [
    { value: ALL, label: "All stages" },
    ...knownStages.map((name) => ({ value: name, label: name })),
  ], [knownStages]);

  if (!allowed) {
    return <MainScreenWrapper>
      <ScreenHeader title="Logs" description="Access and execution logs from live traffic." />
      <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={LockKeyhole} title="Access unavailable" description="Your current team access does not allow this screen." /></div>
    </MainScreenWrapper>;
  }

  if (recordId) {
    return <RequestDetail key={recordId} projectId={project.id} requestId={recordId} onBack={() => setRecordId(null)} />;
  }

  const loading = state.key !== filterKey;
  const field = SEARCH_FIELDS.find((entry) => entry.value === searchField);
  const filtered = Boolean(filters.stage || filters.statusClass || query);

  const columns = [
    {
      key: "request",
      header: "Request",
      render: (row) => <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate font-medium text-foreground">{row.route || row.fields?.resourcePath || "—"}</span>
        <span className="truncate font-mono text-xs text-text-secondary">{row.request_id}</span>
      </div>,
    },
    { key: "status", header: "Status", render: (row) => <RequestStatus status={row.status} /> },
    { key: "stage", header: "Stage", render: (row) => (row.stage ? <Badge variant="outline">{row.stage}</Badge> : <span className="text-sm text-text-secondary">—</span>) },
    { key: "ip", header: "Source IP", render: (row) => <span className="font-mono text-xs text-text-secondary">{row.source_ip || "—"}</span> },
    { key: "time", header: "Time", align: "right", className: "text-right", render: (row) => <span className="text-sm tabular-nums text-text-secondary">{formatTime(row.ts)}</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (row) => <ActionMenu
        label={`Actions for request ${row.request_id}`}
        items={[
          { icon: ExternalLink, label: "Open", onSelect: () => setRecordId(row.request_id) },
          { icon: Copy, label: "Copy request ID", onSelect: () => copy(row.request_id) },
        ]}
      />,
    },
  ];

  return <MainScreenWrapper>
    <ScreenHeader
      title="Logs"
      description="Access logs from live gateway traffic. Open a request for its execution log and trace."
      actions={<>
        <Button variant="outline" className={SECONDARY} onClick={() => setLive((value) => !value)} aria-pressed={live}>
          <span className={cn("h-2 w-2 rounded-full", live ? "animate-pulse bg-emerald-400" : "bg-text-tertiary")} />
          {live ? "Live tail on" : "Live tail"}
        </Button>
        <Button variant="outline" className={SECONDARY} onClick={() => setNonce((value) => value + 1)} disabled={loading}>
          <RefreshCw className="h-4 w-4" />Refresh
        </Button>
      </>}
    />

    <Toolbar>
      <div className="flex flex-wrap items-center gap-2">
        <FilterDropdown label="Status class" value={statusClass} onValueChange={setStatusClass} options={STATUS_CLASS_OPTIONS} height="h-9" />
        <FilterDropdown label="Stage" value={stage} onValueChange={setStage} options={stageOptions} height="h-9" />
        <FilterDropdown label="Search by" value={searchField} onValueChange={setSearchField} options={SEARCH_FIELDS} height="h-9" />
      </div>
      <SearchInput value={search} onChange={setSearch} placeholder={field?.placeholder} />
    </Toolbar>

    {loading ? <LoadingArea panel label="Loading logs" /> : state.status === "error" ? <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={ScrollText}
      title="Logs unavailable"
      description={state.error}
      action={<Button variant="outline" className={SECONDARY} onClick={() => setNonce((value) => value + 1)}>Retry</Button>}
    /></div> : <div className="space-y-5">
      <DataTable
        columns={columns}
        data={pager.pageItems}
        getRowKey={(row) => `${row.request_id}-${row.ts}`}
        onRowClick={(row) => setRecordId(row.request_id)}
        empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
          icon={ScrollText}
          title={filtered ? "No log lines match your filters" : "No log lines yet"}
          description={filtered
            ? "Try clearing the search or filters. Search matches the whole value exactly."
            : "Lines appear here once a stage with access logging enabled serves traffic."}
        /></div>}
      />
      <ListPagination {...pager} itemLabel="lines" />
    </div>}
  </MainScreenWrapper>;
}

function RequestDetail({ projectId, requestId, onBack }) {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState({ key: null, status: "loading", detail: null, error: null });
  const key = `${requestId}|${nonce}`;

  useEffect(() => {
    let alive = true;
    api(projectId, `/${encodeURIComponent(requestId)}`).then(
      (data) => { if (alive) setState({ key, status: "ready", detail: data, error: null }); },
      (error) => { if (alive) setState({ key, status: "error", detail: null, error: error.message }); },
    );
    return () => { alive = false; };
  }, [projectId, requestId, key]);

  const loading = state.key !== key;
  const detail = state.detail;
  const accessRows = detail ? (Array.isArray(detail.access) ? detail.access : detail.access ? [detail.access] : []) : [];
  const access = accessRows[0] ?? null;
  const executionLines = (detail?.execution ?? []).flatMap((row) => row.lines ?? []);

  return <SecondaryScreenWrapper>
    <EditorHeader
      back={{ label: "All Logs", onClick: onBack }}
      title={access?.route || access?.fields?.resourcePath || "Request"}
      status={access?.status ?? undefined}
      statusMap={access ? statusMapFor(access.status) : undefined}
      meta={<span className="inline-flex items-center gap-1.5">
        <span className="font-mono text-xs">{requestId}</span>
        <Button variant="ghost" size="icon-sm" aria-label="Copy request ID" className="text-text-secondary hover:text-foreground" onClick={() => copy(requestId)}><Copy className="h-3.5 w-3.5" /></Button>
      </span>}
      actions={<Button variant="outline" className={SECONDARY} onClick={() => setNonce((value) => value + 1)} disabled={loading}>
        <RefreshCw className="h-4 w-4" />Refresh
      </Button>}
    />

    {loading ? <LoadingArea panel label="Loading request" /> : state.status === "error" ? <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={ScrollText}
      title="Request unavailable"
      description={state.error}
      action={<Button variant="outline" className={SECONDARY} onClick={() => setNonce((value) => value + 1)}>Retry</Button>}
    /></div> : <div className="space-y-6">
      <SectionCard title="Access log" description="The access-log line written for this request.">
        {access ? <div className="space-y-4">
          <dl className="grid gap-4 sm:grid-cols-2">
            <Fact label="Time">{formatTime(access.ts)}</Fact>
            <Fact label="Status"><RequestStatus status={access.status} /></Fact>
            <Fact label="Stage">{access.stage || "—"}</Fact>
            <Fact label="Route">{access.route || "—"}</Fact>
            <Fact label="Source IP"><span className="font-mono text-xs">{access.source_ip || "—"}</span></Fact>
            <Fact label="Request ID"><span className="font-mono text-xs">{access.request_id ?? requestId}</span></Fact>
          </dl>
          <LogBlock>{accessRows.map((row) => row.line).join("\n") || "No access line."}</LogBlock>
        </div> : <p className="text-sm text-text-secondary">No access line for this request.</p>}
      </SectionCard>

      <SectionCard
        title="Execution log"
        description={detail?.bodiesRedacted
          ? "Request and response bodies are hidden — viewing them needs the pods.logs.data permission."
          : "What the gateway did while handling this request."}
      >
        {executionLines.length
          ? <LogBlock className="max-h-80">{executionLines.map((line) => `[${line.level}] ${line.message}`).join("\n")}</LogBlock>
          : <p className="text-sm text-text-secondary">No execution log for this request. Set the stage&apos;s logging level to ERROR or INFO to record one.</p>}
      </SectionCard>

      <SectionCard title="Trace" description="Spans from the sampled trace, in start order.">
        <TraceWaterfall spans={detail?.spans ?? []} />
      </SectionCard>
    </div>}
  </SecondaryScreenWrapper>;
}

function Fact({ label, children }) {
  return <div className="min-w-0">
    <dt className="text-xs text-text-secondary">{label}</dt>
    <dd className="mt-1 break-all text-sm text-foreground">{children}</dd>
  </div>;
}

function LogBlock({ children, className }) {
  return <pre className={cn("overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-surface-card p-3 font-mono text-xs text-foreground", className)}>{children}</pre>;
}

function TraceWaterfall({ spans }) {
  if (!spans.length) return <p className="text-sm text-text-secondary">Not sampled.</p>;
  const rows = spans
    .map((span) => {
      const start = Number(span.start_ms ?? 0);
      const duration = Number(span.duration_ms ?? (span.end_ms != null ? span.end_ms - start : 0)) || 0;
      return { span, start, duration };
    })
    .sort((a, b) => a.start - b.start);
  const base = Math.min(...rows.map((row) => row.start));
  const end = Math.max(...rows.map((row) => row.start - base + row.duration));
  const total = end > 0 ? end : 1;

  return <div className="space-y-2.5">
    {rows.map(({ span, start, duration }, index) => <div key={span.span_id || span.id || index} className="grid grid-cols-[minmax(0,12rem)_1fr_4.5rem] items-center gap-3 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-foreground">{span.name || "span"}</span>
        {span.kind ? <Badge variant="outline" className="shrink-0">{span.kind}</Badge> : null}
      </div>
      <div className="relative h-2 overflow-hidden rounded-full bg-surface-active">
        <div
          className={cn("absolute inset-y-0 rounded-full", span.status === "error" ? "bg-red-400" : "bg-foreground/70")}
          style={{ left: `${((start - base) / total) * 100}%`, width: `${Math.max(1, (duration / total) * 100)}%` }}
        />
      </div>
      <span className="text-right font-mono text-xs tabular-nums text-text-secondary">{span.duration_ms ?? "?"} ms</span>
    </div>)}
  </div>;
}
