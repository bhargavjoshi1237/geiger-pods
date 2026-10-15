"use client";

// Audit Log (`/audit`): every management change, filterable by actor, action,
// resource type/id, API and time. Each entry's before/after JSON is already
// redacted server-side. Export CSV uses the same filters.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, Download, Eye, Loader2, ScrollText, SlidersHorizontal } from "lucide-react";
import { DataTable, EmptyState, Field, LoadingArea, ScreenHeader, SearchInput, SectionCard, Toolbar } from "@/components/internal/shared/screen_kit";
import { MainScreenWrapper, SecondaryScreenWrapper } from "@/components/internal/shared/screen_wrappers";
import { ListPagination, usePagination } from "@/components/internal/shared/pagination";
import { EditorHeader } from "@/components/internal/shared/editor_shell";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRecordParam } from "@/lib/hooks/use-record-param";
import FilterDropdown from "../overview/filter_dropdown";

async function api(projectId, path) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/audit${path}`, {
    headers: { "content-type": "application/json" },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

const PAGE_LIMIT = "100";

const EMPTY_FILTERS = { actor: "", action: "", resourceType: "", resourceId: "", apiId: "", from: "", to: "" };

const SERVER_FIELDS = [
  ["actor", "Actor ID", "00000000-0000-4000-8000-000000000000"],
  ["action", "Action", "deployment.create"],
  ["resourceType", "Resource type", "api"],
  ["resourceId", "Resource ID", ""],
  ["apiId", "API ID", ""],
];

const RANGES = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const formatDateTime = (value) => (value ? new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }) : "—");

const entryId = (entry) => String(entry.id ?? `${entry.created_at ?? entry.createdAt}-${entry.action}`);
const entryAction = (entry) => entry.action ?? entry.action_type ?? "unknown";
const entryResourceType = (entry) => entry.resource_type ?? entry.resourceType ?? "";
const entryResourceId = (entry) => entry.resource_id ?? entry.resourceId ?? "";
const entryTime = (entry) => entry.created_at ?? entry.createdAt ?? null;
const entryActor = (entry) => entry.actor_id ?? entry.actorId ?? "";
const entryApi = (entry) => entry.api_id ?? entry.apiId ?? "";

function toQuery(filters, extra = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value);
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value) query.set(key, value);
  }
  const text = query.toString();
  return text === "" ? "" : `?${text}`;
}

function copy(value, label) {
  navigator.clipboard?.writeText(value).then(
    () => toast.success(`${label} copied.`),
    () => toast.error(`Couldn't copy the ${label.toLowerCase()}.`),
  );
}

const outlineQuiet = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

function JsonBlock({ label, value }) {
  return <div className="min-w-0">
    <p className="text-xs font-medium text-text-secondary">{label}</p>
    <pre className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-surface-card p-3 font-mono text-xs text-foreground">{JSON.stringify(value ?? null, null, 2)}</pre>
  </div>;
}

function AuditEntryDetail({ entry, onBack }) {
  const facts = [
    ["Action", entryAction(entry), false],
    ["Time", formatDateTime(entryTime(entry)), false],
    ["Resource type", entryResourceType(entry) || "—", false],
    ["Resource ID", entryResourceId(entry) || "—", Boolean(entryResourceId(entry))],
    ["API ID", entryApi(entry) || "—", Boolean(entryApi(entry))],
    ["Actor", entryActor(entry) || "—", Boolean(entryActor(entry))],
    ["Actor type", entry.actor_type ?? entry.actorType ?? "—", false],
    ["Request ID", entry.request_id ?? entry.requestId ?? "—", Boolean(entry.request_id ?? entry.requestId)],
  ];
  const hasChange = entry.before != null || entry.after != null;
  return <SecondaryScreenWrapper>
    <EditorHeader
      back={{ label: "Audit Log", onClick: onBack }}
      title={entryAction(entry)}
      meta={[entryResourceType(entry), formatDateTime(entryTime(entry))].filter(Boolean).join(" · ")}
    />
    <div className="mt-6 space-y-6">
      <SectionCard title="Details">
        <dl className="grid gap-4 sm:grid-cols-2">
          {facts.map(([label, value, copyable]) => <div key={label} className="min-w-0">
            <dt className="text-xs text-text-secondary">{label}</dt>
            <dd className="mt-1 flex min-w-0 items-center gap-1 text-sm text-foreground">
              <span className={copyable ? "break-all font-mono text-xs" : "break-words"}>{value}</span>
              {copyable ? <Button variant="ghost" size="icon-sm" aria-label={`Copy ${label}`} className="text-muted-foreground hover:bg-surface-active hover:text-foreground" onClick={() => copy(value, label)}>
                <Copy className="h-3.5 w-3.5" />
              </Button> : null}
            </dd>
          </div>)}
        </dl>
      </SectionCard>
      <SectionCard title="Changes" description="Before and after, with sensitive values redacted when recorded.">
        {hasChange
          ? <div className="grid gap-4 lg:grid-cols-2"><JsonBlock label="Before" value={entry.before} /><JsonBlock label="After" value={entry.after} /></div>
          : <p className="text-sm text-text-secondary">No recorded change.</p>}
      </SectionCard>
    </div>
  </SecondaryScreenWrapper>;
}

function FiltersDialog({ open, onOpenChange, applied, onApply }) {
  // Keyed by `open` in the parent, so the draft starts from the applied filters.
  const [draft, setDraft] = useState(() => ({ ...applied, from: applied.from.slice(0, 10), to: applied.to.slice(0, 10) }));
  const set = (key) => (event) => setDraft((current) => ({ ...current, [key]: event.target.value }));
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-xl bg-background">
      <DialogHeader>
        <DialogTitle>Filter Audit Log</DialogTitle>
        <DialogDescription>Exact-match filters run on the server and also apply to CSV exports.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <div className="grid grid-cols-2 gap-4">
          {SERVER_FIELDS.map(([key, label, placeholder]) => <Field key={key} label={label} htmlFor={`audit-${key}`}>
            <Input id={`audit-${key}`} value={draft[key]} onChange={set(key)} placeholder={placeholder} spellCheck={false} className="font-mono text-xs" />
          </Field>)}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label="From" htmlFor="audit-from"><Input id="audit-from" type="date" value={draft.from} onChange={set("from")} /></Field>
          <Field label="To" htmlFor="audit-to"><Input id="audit-to" type="date" value={draft.to} onChange={set("to")} /></Field>
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onApply({ ...EMPTY_FILTERS })}>Clear All</Button>
        <Button variant="outline" className={outlineQuiet} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => onApply(draft)}>Apply Filters</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function AuditScreen() {
  const { project } = useProject();
  const [applied, setApplied] = useState(EMPTY_FILTERS);
  const [range, setRange] = useState("all");
  const [state, setState] = useState({ status: "loading", items: [], nextCursor: null, error: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [resourceFilter, setResourceFilter] = useState("all");
  const [recordId, setRecordId] = useRecordParam();

  const filterKey = JSON.stringify(applied);

  const load = useCallback(async (filters) => {
    setState({ status: "loading", items: [], nextCursor: null, error: null });
    try {
      const data = await api(project.id, toQuery(filters, { limit: PAGE_LIMIT }));
      setState({ status: "ready", items: data.items ?? data ?? [], nextCursor: data.nextCursor ?? null, error: null });
    } catch (error) {
      setState({ status: "error", items: [], nextCursor: null, error: error.message });
    }
  }, [project.id]);

  useEffect(() => {
    let alive = true;
    const filters = JSON.parse(filterKey);
    api(project.id, toQuery(filters, { limit: PAGE_LIMIT })).then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? data ?? [], nextCursor: data.nextCursor ?? null, error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], nextCursor: null, error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id, filterKey]);

  // Only a real change refetches (via the effect), so only then show loading.
  const commit = (next) => {
    if (JSON.stringify(next) === filterKey) return;
    setState((current) => ({ ...current, status: "loading" }));
    setApplied(next);
  };

  const applyFilters = (next) => {
    setFiltersOpen(false);
    setRange(next.from || next.to ? "custom" : "all");
    commit({ ...EMPTY_FILTERS, ...next });
  };

  const changeRange = (value) => {
    setRange(value);
    if (value === "custom") {
      setFiltersOpen(true);
      return;
    }
    commit({ ...applied, from: RANGES[value] ? new Date(Date.now() - RANGES[value]).toISOString() : "", to: "" });
  };

  const loadMore = async () => {
    if (!state.nextCursor) return;
    setLoadingMore(true);
    try {
      const data = await api(project.id, toQuery(applied, { limit: PAGE_LIMIT, cursor: state.nextCursor }));
      setState((current) => ({ ...current, items: [...current.items, ...(data.items ?? [])], nextCursor: data.nextCursor ?? null }));
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoadingMore(false);
    }
  };

  const exportCsv = () => {
    const anchor = document.createElement("a");
    anchor.href = `/api/v1/projects/${encodeURIComponent(project.id)}/audit/export${toQuery(applied)}`;
    anchor.download = `audit-${project.id}.csv`;
    anchor.click();
  };

  const entries = state.items;

  const resourceOptions = useMemo(() => {
    const types = [...new Set(entries.map(entryResourceType).filter(Boolean))].sort();
    return [{ value: "all", label: "All Resources" }, ...types.map((type) => ({ value: type, label: type }))];
  }, [entries]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return entries.filter((entry) => {
      if (resourceFilter !== "all" && entryResourceType(entry) !== resourceFilter) return false;
      return !query || [entryAction(entry), entryResourceType(entry), entryResourceId(entry), entryActor(entry), entryApi(entry), entry.request_id ?? ""]
        .join(" ").toLowerCase().includes(query);
    });
  }, [entries, search, resourceFilter]);

  const pager = usePagination(filtered, { resetKey: `${search}|${resourceFilter}|${filterKey}` });

  const serverFilterCount = SERVER_FIELDS.filter(([key]) => applied[key]).length + (range === "custom" ? 1 : 0);

  const rangeOptions = [
    { value: "all", label: "All Time" },
    { value: "24h", label: "Last 24 Hours" },
    { value: "7d", label: "Last 7 Days" },
    { value: "30d", label: "Last 30 Days" },
    { value: "custom", label: "Custom Range" },
  ];

  const openEntry = entries.find((entry) => entryId(entry) === recordId) ?? null;
  if (recordId && openEntry) return <AuditEntryDetail entry={openEntry} onBack={() => setRecordId(null)} />;

  const columns = [
    {
      key: "event",
      header: "Event",
      render: (entry) => <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate font-medium text-foreground">{entryAction(entry)}</span>
        <span className="truncate text-xs text-text-secondary">
          {entryResourceType(entry) || "—"}{entryResourceId(entry) ? <> · <span className="font-mono">{entryResourceId(entry)}</span></> : null}
        </span>
      </div>,
    },
    { key: "resource", header: "Resource", render: (entry) => (entryResourceType(entry) ? <Badge variant="neutral">{entryResourceType(entry)}</Badge> : <span className="text-text-tertiary">—</span>) },
    {
      key: "actor",
      header: "Actor",
      render: (entry) => <div className="flex min-w-0 flex-col gap-0.5">
        <span className="max-w-[14rem] truncate font-mono text-xs text-foreground">{entryActor(entry) || "—"}</span>
        {entry.actor_type ? <span className="text-xs text-text-secondary">{entry.actor_type}</span> : null}
      </div>,
    },
    { key: "api", header: "API", render: (entry) => <span className="font-mono text-xs text-text-secondary">{entryApi(entry) || "—"}</span> },
    { key: "time", header: "Time", render: (entry) => <span className="whitespace-nowrap text-sm tabular-nums text-text-secondary">{formatDateTime(entryTime(entry))}</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (entry) => <ActionMenu
        label={`Actions for ${entryAction(entry)}`}
        items={[
          { icon: Eye, label: "View details", onSelect: () => setRecordId(entryId(entry)) },
          entryResourceId(entry) && { icon: Copy, label: "Copy resource ID", onSelect: () => copy(entryResourceId(entry), "Resource ID") },
          entry.request_id && { icon: Copy, label: "Copy request ID", onSelect: () => copy(entry.request_id, "Request ID") },
        ]}
      />,
    },
  ];

  return <MainScreenWrapper>
    <ScreenHeader
      title="Audit Log"
      description="Every management change in this project, newest first. Sensitive values are redacted when recorded."
      actions={<Button variant="outline" className={outlineQuiet} onClick={exportCsv}><Download className="h-4 w-4" /> Export CSV</Button>}
    />

    <Toolbar>
      <div className="flex flex-wrap items-center gap-2">
        <FilterDropdown label="Time range" value={range} onValueChange={changeRange} options={rangeOptions} height="h-9" />
        <FilterDropdown label="Resource type" value={resourceFilter} onValueChange={setResourceFilter} options={resourceOptions} height="h-9" />
        <Button variant="outline" className="h-9 rounded-lg border-border bg-surface-card px-3 text-xs font-medium text-foreground hover:bg-surface-subtle" onClick={() => setFiltersOpen(true)}>
          <SlidersHorizontal className="h-3.5 w-3.5 text-text-secondary" /> Filters{serverFilterCount ? <span className="ml-0.5 rounded bg-surface-strong px-1.5 tabular-nums">{serverFilterCount}</span> : null}
        </Button>
      </div>
      <SearchInput value={search} onChange={setSearch} placeholder="Search actions, resources, actors…" />
    </Toolbar>

    {state.status === "loading" ? <LoadingArea label="Loading audit entries" /> : null}
    {state.status === "error" ? <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={ScrollText}
      title="Audit log unavailable"
      description={state.error}
      action={<Button variant="outline" onClick={() => load(applied)}>Retry</Button>}
    /></div> : null}
    {state.status === "ready" ? <div className="space-y-5">
      <DataTable
        columns={columns}
        data={pager.pageItems}
        getRowKey={entryId}
        onRowClick={(entry) => setRecordId(entryId(entry))}
        empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
          icon={ScrollText}
          title={entries.length || serverFilterCount || range !== "all" ? "No entries match your filters" : "No audit entries yet"}
          description={entries.length || serverFilterCount || range !== "all"
            ? "Try clearing the search or filters."
            : "Management changes appear here once someone creates or edits a resource."}
          action={serverFilterCount || range !== "all" ? <Button variant="outline" onClick={() => applyFilters({ ...EMPTY_FILTERS })}>Clear Filters</Button> : null}
        /></div>}
      />
      <ListPagination {...pager} itemLabel="entries" />
      {state.nextCursor ? <div className="flex justify-center">
        <Button variant="outline" className={outlineQuiet} disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Load Older Entries
        </Button>
      </div> : null}
    </div> : null}

    <FiltersDialog
      key={filtersOpen ? "filters-open" : "filters-closed"}
      open={filtersOpen}
      onOpenChange={(open) => {
        setFiltersOpen(open);
        if (!open && range === "custom" && !applied.from && !applied.to) setRange("all");
      }}
      applied={applied}
      onApply={applyFilters}
    />
  </MainScreenWrapper>;
}
