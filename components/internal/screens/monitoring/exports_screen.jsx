"use client";

// Log Exports: log sinks (https, s3, otlp_logs) with test delivery. Rows open
// the sink's edit page in place (`?record=`). Secret material is never shown
// — configs carry vault refs only.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, Loader2, LockKeyhole, Pause, Pencil, Play, Plus, Send, Trash2, UploadCloud } from "lucide-react";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { Switch } from "@geiger/ui/switch";
import { toast } from "sonner";
import { DataTable, EmptyState, Field, InlineTitleInput, LoadingArea, ScreenHeader, SearchInput, SectionCard, SettingRow, SettingsList, StatsBar, StatusPill, Toolbar } from "@/components/internal/shared/screen_kit";
import { MainScreenWrapper, SecondaryScreenWrapper } from "@/components/internal/shared/screen_wrappers";
import { ListPagination, usePagination } from "@/components/internal/shared/pagination";
import { EditorHeader } from "@/components/internal/shared/editor_shell";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { useRecordParam } from "@/lib/hooks/use-record-param";
import FilterDropdown from "../overview/filter_dropdown";

const PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";
const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

const SINK_TYPES = [
  { value: "https", label: "HTTPS", summary: "Signed NDJSON batches posted to your endpoint." },
  { value: "s3", label: "S3", summary: "Gzipped NDJSON objects in an S3-compatible bucket." },
  { value: "otlp_logs", label: "OTLP logs", summary: "Log records sent to an OpenTelemetry collector." },
];
const TYPE_LABEL = Object.fromEntries(SINK_TYPES.map((entry) => [entry.value, entry.label]));

const STATUS_MAP = {
  active: { label: "Active", variant: "success", dotClass: "bg-emerald-400" },
  error: { label: "Failing", variant: "danger", dotClass: "bg-red-400" },
  disabled: { label: "Disabled", variant: "neutral", dotClass: "bg-[#737373]" },
};

const TYPE_FILTER_OPTIONS = [{ value: "all", label: "All types" }, ...SINK_TYPES.map((entry) => ({ value: entry.value, label: entry.label }))];
const STATUS_FILTER_OPTIONS = [{ value: "all", label: "All statuses" }, ...Object.entries(STATUS_MAP).map(([value, meta]) => ({ value, label: meta.label }))];

async function api(projectId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/log-sinks${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

const formatDate = (value) => (value
  ? new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
  : "—");

function destinationOf(sink) {
  if (sink.type === "https") return sink.config?.url ?? "";
  if (sink.type === "s3") return `${sink.config?.bucket ?? ""}/${sink.config?.prefix ?? ""}`;
  return sink.config?.endpoint ?? "";
}

function copy(value) {
  navigator.clipboard?.writeText(value).then(
    () => toast.success("Copied."),
    () => toast.error("Couldn't copy to the clipboard."),
  );
}

const EMPTY_DRAFT = { name: "", type: "https", url: "", bucket: "", prefix: "", secretRef: "" };

function draftOf(sink) {
  const config = sink.config ?? {};
  return {
    name: sink.name ?? "",
    type: sink.type ?? "https",
    url: config.url ?? config.endpoint ?? "",
    bucket: config.bucket ?? "",
    prefix: config.prefix ?? "",
    secretRef: config.secretRef ?? config.hmacSecretRef ?? config.credentialsRef ?? "",
  };
}

function configOf(draft) {
  if (draft.type === "https") return { url: draft.url.trim(), secretRef: draft.secretRef.trim() };
  if (draft.type === "s3") return { bucket: draft.bucket.trim(), prefix: draft.prefix.trim(), credentialsRef: draft.secretRef.trim() };
  return { endpoint: draft.url.trim() };
}

function TypeSelect({ id, value, onValueChange, disabled }) {
  return <Select value={value} onValueChange={onValueChange} disabled={disabled}>
    <SelectTrigger id={id}><SelectValue /></SelectTrigger>
    <SelectContent>
      {SINK_TYPES.map((entry) => <SelectItem key={entry.value} value={entry.value}>{entry.label}</SelectItem>)}
    </SelectContent>
  </Select>;
}

// The type-specific destination fields, shared by create and edit.
function DestinationFields({ draft, set, disabled, idPrefix }) {
  if (draft.type === "s3") {
    return <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Bucket" htmlFor={`${idPrefix}-bucket`}>
          <Input id={`${idPrefix}-bucket`} value={draft.bucket} onChange={(event) => set("bucket")(event.target.value)} spellCheck={false} disabled={disabled} />
        </Field>
        <Field label="Prefix" htmlFor={`${idPrefix}-prefix`}>
          <Input id={`${idPrefix}-prefix`} value={draft.prefix} onChange={(event) => set("prefix")(event.target.value)} placeholder="pods-logs" spellCheck={false} disabled={disabled} />
        </Field>
      </div>
      <Field label="Credentials ref" hint="Vault secret ref, e.g. secret:<id>@<version>." htmlFor={`${idPrefix}-secret`}>
        <Input id={`${idPrefix}-secret`} value={draft.secretRef} onChange={(event) => set("secretRef")(event.target.value)} placeholder="secret:<id>@<version>" className="font-mono" spellCheck={false} disabled={disabled} />
      </Field>
    </>;
  }
  if (draft.type === "otlp_logs") {
    return <Field label="Endpoint" htmlFor={`${idPrefix}-url`}>
      <Input id={`${idPrefix}-url`} value={draft.url} onChange={(event) => set("url")(event.target.value)} placeholder="https://otel.example.com/v1/logs" spellCheck={false} disabled={disabled} />
    </Field>;
  }
  return <>
    <Field label="URL" htmlFor={`${idPrefix}-url`}>
      <Input id={`${idPrefix}-url`} value={draft.url} onChange={(event) => set("url")(event.target.value)} placeholder="https://logs.example.com/ingest" inputMode="url" spellCheck={false} disabled={disabled} />
    </Field>
    <Field label="Signing secret ref" hint="Vault secret ref used to sign batches (x-pods-signature), e.g. secret:<id>@<version>." htmlFor={`${idPrefix}-secret`}>
      <Input id={`${idPrefix}-secret`} value={draft.secretRef} onChange={(event) => set("secretRef")(event.target.value)} placeholder="secret:<id>@<version>" className="font-mono" spellCheck={false} disabled={disabled} />
    </Field>
  </>;
}

function CreateSinkDialog({ open, onOpenChange, onCreated }) {
  const { project } = useProject();
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const set = (key) => (value) => setDraft((prev) => ({ ...prev, [key]: value }));

  const submit = async () => {
    const name = draft.name.trim();
    if (!name) {
      toast.error("Give your sink a name first.");
      return;
    }
    setSaving(true);
    try {
      await api(project.id, "", { method: "POST", body: JSON.stringify({ name, type: draft.type, config: configOf(draft) }) });
      toast.success(`"${name}" created.`);
      setDraft(EMPTY_DRAFT);
      onOpenChange(false);
      await onCreated();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-xl bg-background">
      <DialogHeader>
        <DialogTitle>Create Sink</DialogTitle>
        <DialogDescription>Credentials stay as vault secret refs — plaintext never appears here.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="sink-name">
            <Input id="sink-name" value={draft.name} onChange={(event) => set("name")(event.target.value)} placeholder="e.g. siem-ingest" maxLength={128} autoFocus />
          </Field>
          <Field label="Type" htmlFor="sink-type">
            <TypeSelect id="sink-type" value={draft.type} onValueChange={set("type")} />
          </Field>
        </div>
        <p className="text-xs text-text-secondary">{SINK_TYPES.find((entry) => entry.value === draft.type)?.summary}</p>
        <DestinationFields draft={draft} set={set} idPrefix="sink-create" />
      </div>
      <DialogFooter>
        <Button variant="outline" className={SECONDARY} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button className={PRIMARY} onClick={submit} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Create Sink</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function DeleteSinkDialog({ sink, onCancel, onConfirm }) {
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm(sink);
    } finally {
      setBusy(false);
    }
  };
  return <Dialog open={!!sink} onOpenChange={(open) => { if (!open) onCancel(); }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Delete sink</DialogTitle>
        <DialogDescription>
          Are you sure you want to delete <span className="font-medium text-foreground">{sink?.name}</span>? Stages that send logs to it stop exporting there. This action can&apos;t be undone.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button className="bg-red-500/90 text-white hover:bg-red-500" disabled={busy} onClick={confirm}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Delete
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function ExportsScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [recordId, setRecordId] = useRecordParam();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [testing, setTesting] = useState(null);
  const [search, setSearch] = useState("");
  const [type, setType] = useState("all");
  const [status, setStatus] = useState("all");
  const writable = can("pods.export.write");
  const allowed = can("pods.monitoring.view");

  const refresh = useCallback(async () => {
    try {
      const data = await api(project.id, "");
      setState({ status: "ready", items: data.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [project.id]);

  useEffect(() => {
    if (!allowed) return undefined;
    let alive = true;
    api(project.id, "").then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [allowed, project.id]);

  const sinks = state.items;
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return sinks.filter((sink) => {
      if (type !== "all" && sink.type !== type) return false;
      if (status !== "all" && sink.status !== status) return false;
      return !query || `${sink.name} ${destinationOf(sink)} ${sink.id}`.toLowerCase().includes(query);
    });
  }, [sinks, search, type, status]);
  const pager = usePagination(filtered, { resetKey: `${search}|${type}|${status}` });

  const stats = useMemo(() => {
    const count = (value) => sinks.filter((sink) => sink.status === value).length;
    return [
      { label: "Total sinks", value: String(sinks.length), footer: "Across this project" },
      { label: "Active", value: String(count("active")), footer: "Delivering" },
      { label: "Failing", value: String(count("error")), footer: "Last delivery failed" },
      { label: "Disabled", value: String(count("disabled")), footer: "Paused" },
    ];
  }, [sinks]);

  const testDelivery = async (sink) => {
    setTesting(sink.id);
    try {
      await api(project.id, `/${encodeURIComponent(sink.id)}/test`, { method: "POST" });
      toast.success("Test batch delivered.");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setTesting(null);
      await refresh();
    }
  };

  const setEnabled = async (sink, enabled) => {
    try {
      await api(project.id, `/${encodeURIComponent(sink.id)}`, {
        method: "PATCH",
        headers: { "if-match": `"${sink.version ?? 1}"` },
        body: JSON.stringify({ status: enabled ? "active" : "disabled" }),
      });
      toast.success(enabled ? `Enabled "${sink.name}".` : `Disabled "${sink.name}".`);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const deleteSink = async (sink) => {
    try {
      await api(project.id, `/${encodeURIComponent(sink.id)}`, { method: "DELETE" });
      toast.success(`Deleted "${sink.name}".`);
      setDeleteTarget(null);
      if (recordId === sink.id) setRecordId(null);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    }
  };

  if (!allowed) {
    return <MainScreenWrapper>
      <ScreenHeader title="Log Exports" description="Stream access logs to https endpoints or S3-compatible storage." />
      <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={LockKeyhole} title="Access unavailable" description="Your current team access does not allow this screen." /></div>
    </MainScreenWrapper>;
  }

  const deleteDialog = writable ? <DeleteSinkDialog sink={deleteTarget} onCancel={() => setDeleteTarget(null)} onConfirm={deleteSink} /> : null;

  if (recordId) {
    if (state.status === "loading") return <LoadingArea />;
    const sink = sinks.find((entry) => entry.id === recordId);
    if (!sink) {
      return <MainScreenWrapper>
        <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
          icon={UploadCloud}
          title={state.status === "error" ? "Sinks unavailable" : "Sink not found"}
          description={state.status === "error" ? state.error : "It may have been deleted."}
          action={<Button variant="outline" className={SECONDARY} onClick={() => setRecordId(null)}>Back to Log Exports</Button>}
        /></div>
      </MainScreenWrapper>;
    }
    return <>
      <SinkEditPage
        key={`${sink.id}|${sink.version}`}
        sink={sink}
        writable={writable}
        testing={testing === sink.id}
        onBack={() => setRecordId(null)}
        onSaved={refresh}
        onTest={() => testDelivery(sink)}
        onDelete={() => setDeleteTarget(sink)}
      />
      {deleteDialog}
    </>;
  }

  const columns = [
    {
      key: "name",
      header: "Sink",
      render: (sink) => <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate font-medium text-foreground">{sink.name}</span>
        <span className="truncate font-mono text-xs text-text-secondary">{destinationOf(sink) || "—"}</span>
      </div>,
    },
    { key: "type", header: "Type", render: (sink) => <Badge variant="outline">{TYPE_LABEL[sink.type] ?? sink.type}</Badge> },
    {
      key: "status",
      header: "Status",
      render: (sink) => <div className="flex min-w-0 flex-col items-start gap-1">
        <StatusPill status={sink.status} map={STATUS_MAP} />
        {sink.lastError ? <span className="line-clamp-1 max-w-xs text-xs text-text-secondary">{sink.lastError}</span> : null}
      </div>,
    },
    { key: "delivered", header: "Last delivery", align: "right", className: "text-right", render: (sink) => <span className="text-sm tabular-nums text-text-secondary">{sink.lastDeliveryAt ? formatDate(sink.lastDeliveryAt) : "Never"}</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (sink) => <ActionMenu
        label={`Actions for ${sink.name}`}
        items={[
          { icon: Pencil, label: writable ? "Edit" : "Open", onSelect: () => setRecordId(sink.id) },
          writable && sink.type === "https" && { icon: Send, label: "Send test batch", disabled: testing === sink.id, onSelect: () => testDelivery(sink) },
          { icon: Copy, label: "Copy sink ID", onSelect: () => copy(sink.id) },
          writable && (sink.status === "disabled"
            ? { icon: Play, label: "Enable", onSelect: () => setEnabled(sink, true) }
            : { icon: Pause, label: "Disable", onSelect: () => setEnabled(sink, false) }),
          writable && { separator: true },
          writable && { icon: Trash2, label: "Delete", destructive: true, onSelect: () => setDeleteTarget(sink) },
        ]}
      />,
    },
  ];

  const createButton = writable ? <Button className={PRIMARY} onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New Sink</Button> : null;

  return <MainScreenWrapper>
    <ScreenHeader
      title="Log Exports"
      description="Stream access logs to your own systems: https endpoints get signed NDJSON batches, S3 buckets get gzipped objects. Point a stage's log destinations at a sink to start exporting."
      actions={createButton}
    />

    <StatsBar stats={stats} />

    <Toolbar>
      <div className="flex flex-wrap items-center gap-2">
        <FilterDropdown label="Type" value={type} onValueChange={setType} options={TYPE_FILTER_OPTIONS} height="h-9" />
        <FilterDropdown label="Status" value={status} onValueChange={setStatus} options={STATUS_FILTER_OPTIONS} height="h-9" />
      </div>
      <SearchInput value={search} onChange={setSearch} placeholder="Search sinks, destinations, IDs…" />
    </Toolbar>

    {state.status === "loading" ? <LoadingArea panel label="Loading export sinks" /> : state.status === "error" ? <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={UploadCloud}
      title="Sinks unavailable"
      description={state.error}
      action={<Button variant="outline" className={SECONDARY} onClick={() => { setState({ status: "loading", items: [], error: null }); refresh(); }}>Retry</Button>}
    /></div> : <div className="space-y-5">
      <DataTable
        columns={columns}
        data={pager.pageItems}
        getRowKey={(sink) => sink.id}
        onRowClick={(sink) => setRecordId(sink.id)}
        empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
          icon={UploadCloud}
          title={sinks.length ? "No sinks match your filters" : "No sinks yet"}
          description={sinks.length
            ? "Try clearing the search or filters."
            : "Create one, then reference it from a stage's log destinations."}
          action={sinks.length ? null : createButton}
        /></div>}
      />
      <ListPagination {...pager} itemLabel="sinks" />
    </div>}

    {writable ? <CreateSinkDialog open={creating} onOpenChange={setCreating} onCreated={refresh} /> : null}
    {deleteDialog}
  </MainScreenWrapper>;
}

function SinkEditPage({ sink, writable, testing, onBack, onSaved, onTest, onDelete }) {
  const { project } = useProject();
  const [draft, setDraft] = useState(() => draftOf(sink));
  const [enabled, setEnabled] = useState(sink.status !== "disabled");
  const [saving, setSaving] = useState(false);
  const set = (key) => (value) => setDraft((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    const name = draft.name.trim();
    if (!name) {
      toast.error("Give your sink a name first.");
      return;
    }
    // Keep config keys this form doesn't edit (e.g. OTLP headers) unless the type changed.
    const config = draft.type === sink.type ? { ...(sink.config ?? {}), ...configOf(draft) } : configOf(draft);
    const body = { name, type: draft.type, config };
    if (enabled !== (sink.status !== "disabled")) body.status = enabled ? "active" : "disabled";
    setSaving(true);
    try {
      await api(project.id, `/${encodeURIComponent(sink.id)}`, {
        method: "PATCH",
        headers: { "if-match": `"${sink.version ?? 1}"` },
        body: JSON.stringify(body),
      });
      toast.success("Saved.");
      await onSaved();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  return <SecondaryScreenWrapper>
    <EditorHeader
      back={{ label: "All Log Exports", onClick: onBack }}
      title={writable
        ? <InlineTitleInput
          value={draft.name}
          onChange={(event) => set("name")(event.target.value)}
          aria-label="Sink name"
          placeholder="Untitled sink"
          className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl"
        />
        : sink.name}
      status={sink.status}
      statusMap={STATUS_MAP}
      badges={<Badge variant="outline">{TYPE_LABEL[sink.type] ?? sink.type}</Badge>}
      actions={writable ? <>
        {sink.type === "https" ? <Button variant="outline" className={SECONDARY} disabled={testing} onClick={onTest}>
          {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}Send Test Batch
        </Button> : null}
        <Button className={PRIMARY} disabled={saving} onClick={save}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {saving ? "Saving…" : "Save Changes"}
        </Button>
      </> : null}
    />

    <SectionCard title="Destination" description="Where batches are delivered. Credentials stay as vault secret refs.">
      <div className="grid gap-4">
        <Field label="Type" htmlFor="sink-edit-type">
          <TypeSelect id="sink-edit-type" value={draft.type} onValueChange={set("type")} disabled={!writable} />
        </Field>
        <DestinationFields draft={draft} set={set} disabled={!writable} idPrefix="sink-edit" />
      </div>
    </SectionCard>

    <SectionCard title="Delivery" description="Stages keep their reference to this sink while it's disabled.">
      <div className="space-y-5">
        <SettingsList>
          <SettingRow
            title="Deliver logs"
            description={enabled ? "Batches are sent as stages log requests." : "Nothing is sent until you turn this back on."}
            control={<Switch checked={enabled} onCheckedChange={setEnabled} disabled={!writable} />}
          />
        </SettingsList>
        <dl className="grid gap-4 border-t border-border pt-5 sm:grid-cols-2">
          <Fact label="Last delivery">{sink.lastDeliveryAt ? formatDate(sink.lastDeliveryAt) : "Never"}</Fact>
          <Fact label="Last error">{sink.lastError || "—"}</Fact>
          <Fact label="Sink ID">
            <span className="inline-flex max-w-full items-center gap-1.5">
              <span className="truncate font-mono text-xs">{sink.id}</span>
              <Button variant="ghost" size="icon-sm" aria-label="Copy sink ID" className="text-text-secondary hover:text-foreground" onClick={() => copy(sink.id)}><Copy className="h-3.5 w-3.5" /></Button>
            </span>
          </Fact>
          <Fact label="Created">{formatDate(sink.createdAt)}</Fact>
        </dl>
      </div>
    </SectionCard>

    {writable ? <SectionCard title="Danger zone" description="Deleting a sink stops every export to it.">
      <Button className="bg-red-500/90 text-white hover:bg-red-500" onClick={onDelete}><Trash2 className="h-4 w-4" />Delete Sink</Button>
    </SectionCard> : null}
  </SecondaryScreenWrapper>;
}

function Fact({ label, children }) {
  return <div className="min-w-0">
    <dt className="text-xs text-text-secondary">{label}</dt>
    <dd className="mt-1 break-words text-sm text-foreground">{children}</dd>
  </div>;
}
