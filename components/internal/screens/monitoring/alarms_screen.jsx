"use client";

// Alarms: M-of-N alarms over gateway metrics. The list opens an alarm's edit
// page in place (`?record=`) with its condition, notifications (per-state
// channel picks plus the project's notification channels) and history.

import { useCallback, useEffect, useMemo, useState } from "react";
import { BellRing, BellOff, Gauge, History, Loader2, LockKeyhole, Pencil, Plus, Trash2, Webhook } from "lucide-react";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Checkbox } from "@geiger/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { Switch } from "@geiger/ui/switch";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { DataTable, EmptyState, Field, InlineTitleInput, LoadingArea, ScreenHeader, SearchInput, SectionCard, StatsBar, StatusPill, Toolbar } from "@/components/internal/shared/screen_kit";
import { MainScreenWrapper } from "@/components/internal/shared/screen_wrappers";
import { ListPagination, usePagination } from "@/components/internal/shared/pagination";
import { EditorShell } from "@/components/internal/shared/editor_shell";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { useRecordParam } from "@/lib/hooks/use-record-param";
import FilterDropdown from "../overview/filter_dropdown";

const PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";
const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

const STATE_MAP = {
  OK: { label: "OK", variant: "success", dotClass: "bg-emerald-400" },
  ALARM: { label: "In alarm", variant: "danger", dotClass: "bg-red-400" },
  INSUFFICIENT_DATA: { label: "Insufficient data", variant: "neutral", dotClass: "bg-[#737373]" },
};

const STATE_FILTER_OPTIONS = [
  { value: "all", label: "All states" },
  ...Object.entries(STATE_MAP).map(([value, meta]) => ({ value, label: meta.label })),
];

// Mirrors the gateway's recorded metrics (lib/gateway/core/observe/metrics.mjs).
const METRIC_GROUPS = [
  { label: "REST", metrics: ["Count", "4XXError", "5XXError", "Latency", "IntegrationLatency", "CacheHitCount", "CacheMissCount"] },
  { label: "HTTP", metrics: ["4xx", "5xx", "DataProcessed"] },
  { label: "WebSocket", metrics: ["ConnectCount", "MessageCount", "IntegrationError", "ClientError", "ExecutionError"] },
  { label: "Gateway", metrics: ["ThrottleCount", "QuotaRejectCount", "AuthorizerLatency", "KvFallbackCount", "DroppedEvents", "CacheStoreSkipped"] },
];
const KNOWN_METRICS = new Set(METRIC_GROUPS.flatMap((group) => group.metrics));
const STATISTICS = ["Sum", "Average", "Minimum", "Maximum", "SampleCount", "p50", "p90", "p95", "p99"];
const COMPARISONS = [
  { value: ">", label: "Greater than (>)" },
  { value: ">=", label: "Greater than or equal (>=)" },
  { value: "<", label: "Less than (<)" },
  { value: "<=", label: "Less than or equal (<=)" },
];
const MISSING_DATA = [
  { value: "missing", label: "Missing (keep state)" },
  { value: "notBreaching", label: "Not breaching" },
  { value: "breaching", label: "Breaching" },
  { value: "ignore", label: "Ignore" },
];

const CHANNEL_TYPES = [
  { value: "webhook", label: "Webhook" },
  { value: "slack_webhook", label: "Slack webhook" },
  { value: "email", label: "Email" },
];
const CHANNEL_LABEL = Object.fromEntries(CHANNEL_TYPES.map((entry) => [entry.value, entry.label]));

const NOTIFY_STATES = [
  { key: "alarm", state: "ALARM", title: "Enters alarm", description: "The metric breached the threshold." },
  { key: "ok", state: "OK", title: "Returns to OK", description: "The metric is back within the threshold." },
  { key: "insufficientData", state: "INSUFFICIENT_DATA", title: "Insufficient data", description: "Not enough datapoints to evaluate." },
];

async function request(projectId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

const alarmPath = (id = "") => `/alarms${id ? `/${encodeURIComponent(id)}` : ""}`;
const channelPath = (id = "") => `/alarm-channels${id ? `/${encodeURIComponent(id)}` : ""}`;

const formatDate = (value) => (value
  ? new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
  : "—");

function conditionOf(alarm) {
  return `${alarm.metric} ${alarm.statistic} ${alarm.comparison} ${alarm.threshold} · ${alarm.datapointsToAlarm ?? alarm.evaluationPeriods} of ${alarm.evaluationPeriods} × ${alarm.periodSec}s`;
}

function channelTarget(channel) {
  return channel.config?.url || channel.config?.to || CHANNEL_LABEL[channel.type] || channel.type;
}

function MetricSelect({ id, value, onValueChange, disabled }) {
  return <Select value={value} onValueChange={onValueChange} disabled={disabled}>
    <SelectTrigger id={id}><SelectValue placeholder="Select a metric" /></SelectTrigger>
    <SelectContent>
      {value && !KNOWN_METRICS.has(value) ? <SelectItem value={value}>{value}</SelectItem> : null}
      {METRIC_GROUPS.map((group) => <SelectGroup key={group.label}>
        <SelectLabel>{group.label}</SelectLabel>
        {group.metrics.map((metric) => <SelectItem key={metric} value={metric}>{metric}</SelectItem>)}
      </SelectGroup>)}
    </SelectContent>
  </Select>;
}

function OptionSelect({ id, value, onValueChange, options, disabled }) {
  const entries = options.map((option) => (typeof option === "string" ? { value: option, label: option } : option));
  return <Select value={value} onValueChange={onValueChange} disabled={disabled}>
    <SelectTrigger id={id}><SelectValue /></SelectTrigger>
    <SelectContent>
      {value && !entries.some((entry) => entry.value === value) ? <SelectItem value={value}>{value}</SelectItem> : null}
      {entries.map((entry) => <SelectItem key={entry.value} value={entry.value}>{entry.label}</SelectItem>)}
    </SelectContent>
  </Select>;
}

const EMPTY_ALARM = {
  name: "",
  metric: "",
  statistic: "Sum",
  comparison: ">",
  threshold: "10",
  periodSec: "300",
  evaluationPeriods: "3",
  datapointsToAlarm: "2",
  treatMissingData: "missing",
};

// Shared by the create dialog and the edit page: the condition fields.
function ConditionFields({ draft, set, disabled, idPrefix }) {
  return <>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Metric" htmlFor={`${idPrefix}-metric`}>
        <MetricSelect id={`${idPrefix}-metric`} value={draft.metric} onValueChange={set("metric")} disabled={disabled} />
      </Field>
      <Field label="Statistic" htmlFor={`${idPrefix}-statistic`}>
        <OptionSelect id={`${idPrefix}-statistic`} value={draft.statistic} onValueChange={set("statistic")} options={STATISTICS} disabled={disabled} />
      </Field>
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Comparison" htmlFor={`${idPrefix}-comparison`}>
        <OptionSelect id={`${idPrefix}-comparison`} value={draft.comparison} onValueChange={set("comparison")} options={COMPARISONS} disabled={disabled} />
      </Field>
      <Field label="Threshold" htmlFor={`${idPrefix}-threshold`}>
        <Input id={`${idPrefix}-threshold`} type="number" step="any" value={draft.threshold} onChange={(event) => set("threshold")(event.target.value)} disabled={disabled} />
      </Field>
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Period (seconds)" hint="A multiple of 60." htmlFor={`${idPrefix}-period`}>
        <Input id={`${idPrefix}-period`} type="number" min={60} step={60} value={draft.periodSec} onChange={(event) => set("periodSec")(event.target.value)} disabled={disabled} />
      </Field>
      <Field label="Treat missing data as" htmlFor={`${idPrefix}-missing`}>
        <OptionSelect id={`${idPrefix}-missing`} value={draft.treatMissingData} onValueChange={set("treatMissingData")} options={MISSING_DATA} disabled={disabled} />
      </Field>
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Evaluation periods (N)" hint="1 to 60 most recent periods." htmlFor={`${idPrefix}-periods`}>
        <Input id={`${idPrefix}-periods`} type="number" min={1} max={60} value={draft.evaluationPeriods} onChange={(event) => set("evaluationPeriods")(event.target.value)} disabled={disabled} />
      </Field>
      <Field label="Datapoints to alarm (M)" hint="Breaching periods out of N." htmlFor={`${idPrefix}-datapoints`}>
        <Input id={`${idPrefix}-datapoints`} type="number" min={1} value={draft.datapointsToAlarm} onChange={(event) => set("datapointsToAlarm")(event.target.value)} disabled={disabled} />
      </Field>
    </div>
  </>;
}

function CreateAlarmDialog({ open, onOpenChange, onCreated }) {
  const { project } = useProject();
  const [draft, setDraft] = useState(EMPTY_ALARM);
  const [saving, setSaving] = useState(false);
  const set = (key) => (value) => setDraft((prev) => ({ ...prev, [key]: value }));

  const submit = async () => {
    const name = draft.name.trim();
    if (!name) {
      toast.error("Give your alarm a name first.");
      return;
    }
    if (!draft.metric) {
      toast.error("Pick a metric to watch.");
      return;
    }
    const payload = {
      name,
      metric: draft.metric,
      statistic: draft.statistic,
      comparison: draft.comparison,
      threshold: Number(draft.threshold),
      periodSec: Number(draft.periodSec),
      evaluationPeriods: Number(draft.evaluationPeriods),
      datapointsToAlarm: Number(draft.datapointsToAlarm),
      treatMissingData: draft.treatMissingData,
    };
    setSaving(true);
    try {
      await request(project.id, alarmPath(), { method: "POST", body: JSON.stringify(payload) });
      toast.success(`"${name}" created.`);
      setDraft(EMPTY_ALARM);
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
        <DialogTitle>Create Alarm</DialogTitle>
        <DialogDescription>Set the condition now — pick who gets notified from the alarm&apos;s page.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <Field label="Name" htmlFor="alarm-name">
          <Input id="alarm-name" value={draft.name} onChange={(event) => set("name")(event.target.value)} placeholder="e.g. high-5xx" maxLength={128} autoFocus />
        </Field>
        <ConditionFields draft={draft} set={set} idPrefix="alarm-create" />
      </div>
      <DialogFooter>
        <Button variant="outline" className={SECONDARY} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button className={PRIMARY} onClick={submit} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Create Alarm</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function CreateChannelDialog({ open, onOpenChange, onCreated }) {
  const { project } = useProject();
  const [draft, setDraft] = useState({ name: "", type: "webhook", target: "" });
  const [saving, setSaving] = useState(false);
  const isEmail = draft.type === "email";

  const submit = async () => {
    const name = draft.name.trim();
    if (!name) {
      toast.error("Give your channel a name first.");
      return;
    }
    const target = draft.target.trim();
    if (!target) {
      toast.error(isEmail ? "Add the email address to notify." : "Add the URL to notify.");
      return;
    }
    setSaving(true);
    try {
      await request(project.id, channelPath(), {
        method: "POST",
        body: JSON.stringify({ name, type: draft.type, config: isEmail ? { to: target } : { url: target } }),
      });
      toast.success(`"${name}" created.`);
      setDraft({ name: "", type: "webhook", target: "" });
      onOpenChange(false);
      await onCreated();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md bg-background">
      <DialogHeader>
        <DialogTitle>New Channel</DialogTitle>
        <DialogDescription>Where alarm notifications are delivered. Every alarm in this project can use it.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <Field label="Name" htmlFor="channel-name">
          <Input id="channel-name" value={draft.name} onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))} placeholder="e.g. on-call" maxLength={128} autoFocus />
        </Field>
        <Field label="Type" htmlFor="channel-type">
          <OptionSelect id="channel-type" value={draft.type} onValueChange={(type) => setDraft((prev) => ({ ...prev, type }))} options={CHANNEL_TYPES} />
        </Field>
        <Field label={isEmail ? "Email address" : "URL"} hint={isEmail ? null : "Must be an https URL."} htmlFor="channel-target">
          <Input
            id="channel-target"
            type={isEmail ? "email" : "url"}
            value={draft.target}
            onChange={(event) => setDraft((prev) => ({ ...prev, target: event.target.value }))}
            placeholder={isEmail ? "oncall@example.com" : "https://hooks.example.com/alarms"}
            spellCheck={false}
          />
        </Field>
      </div>
      <DialogFooter>
        <Button variant="outline" className={SECONDARY} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button className={PRIMARY} onClick={submit} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Create Channel</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function ConfirmDeleteDialog({ target, kind, consequence, onCancel, onConfirm }) {
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm(target);
    } finally {
      setBusy(false);
    }
  };
  return <Dialog open={!!target} onOpenChange={(open) => { if (!open) onCancel(); }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Delete {kind}</DialogTitle>
        <DialogDescription>
          Are you sure you want to delete <span className="font-medium text-foreground">{target?.name}</span>? {consequence} This action can&apos;t be undone.
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

export function AlarmsScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [recordId, setRecordId] = useRecordParam();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [channels, setChannels] = useState({ status: "loading", items: [], error: null });
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [openSection, setOpenSection] = useState("condition");
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const writable = can("pods.alarm.write");
  const allowed = can("pods.monitoring.view");

  const refresh = useCallback(async () => {
    try {
      const data = await request(project.id, alarmPath());
      setState({ status: "ready", items: data.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [project.id]);

  const refreshChannels = useCallback(async () => {
    try {
      const data = await request(project.id, channelPath());
      setChannels({ status: "ready", items: data.items ?? [], error: null });
    } catch (error) {
      setChannels({ status: "error", items: [], error: error.message });
    }
  }, [project.id]);

  useEffect(() => {
    if (!allowed) return undefined;
    let alive = true;
    request(project.id, alarmPath()).then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    request(project.id, channelPath()).then(
      (data) => { if (alive) setChannels({ status: "ready", items: data.items ?? [], error: null }); },
      (error) => { if (alive) setChannels({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [allowed, project.id]);

  const alarms = state.items;
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return alarms.filter((alarm) => {
      if (stateFilter !== "all" && alarm.state !== stateFilter) return false;
      return !query || `${alarm.name} ${alarm.description ?? ""} ${alarm.metric}`.toLowerCase().includes(query);
    });
  }, [alarms, search, stateFilter]);
  const pager = usePagination(filtered, { resetKey: `${search}|${stateFilter}` });

  const stats = useMemo(() => {
    const count = (value) => alarms.filter((alarm) => alarm.state === value).length;
    const enabled = alarms.filter((alarm) => alarm.enabled !== false).length;
    return [
      { label: "Total alarms", value: String(alarms.length), footer: `${enabled} enabled` },
      { label: "In alarm", value: String(count("ALARM")), footer: "Breaching now" },
      { label: "OK", value: String(count("OK")), footer: "Within threshold" },
      { label: "Insufficient data", value: String(count("INSUFFICIENT_DATA")), footer: "Not enough datapoints" },
    ];
  }, [alarms]);

  const openAlarm = (alarm, section = "condition") => {
    setOpenSection(section);
    setRecordId(alarm.id);
  };

  const toggleEnabled = async (alarm) => {
    try {
      await request(project.id, alarmPath(alarm.id), { method: "PATCH", body: JSON.stringify({ enabled: alarm.enabled === false }) });
      toast.success(alarm.enabled === false ? `Enabled "${alarm.name}".` : `Disabled "${alarm.name}".`);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const deleteAlarm = async (alarm) => {
    try {
      await request(project.id, alarmPath(alarm.id), { method: "DELETE" });
      toast.success(`Deleted "${alarm.name}".`);
      setDeleteTarget(null);
      if (recordId === alarm.id) setRecordId(null);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    }
  };

  if (!allowed) {
    return <MainScreenWrapper>
      <ScreenHeader title="Alarms" description="Get notified when a gateway metric crosses a threshold." />
      <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={LockKeyhole} title="Access unavailable" description="Your current team access does not allow this screen." /></div>
    </MainScreenWrapper>;
  }

  const confirmDialog = writable ? <ConfirmDeleteDialog
    target={deleteTarget}
    kind="alarm"
    consequence="It stops evaluating and its history is removed."
    onCancel={() => setDeleteTarget(null)}
    onConfirm={deleteAlarm}
  /> : null;

  if (recordId) {
    if (state.status === "loading") return <LoadingArea />;
    const alarm = alarms.find((entry) => entry.id === recordId);
    if (!alarm) {
      return <MainScreenWrapper>
        <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
          icon={BellRing}
          title={state.status === "error" ? "Alarms unavailable" : "Alarm not found"}
          description={state.status === "error" ? state.error : "It may have been deleted."}
          action={<Button variant="outline" className={SECONDARY} onClick={() => setRecordId(null)}>Back to Alarms</Button>}
        /></div>
      </MainScreenWrapper>;
    }
    return <>
      <AlarmEditPage
        key={alarm.id}
        alarm={alarm}
        channels={channels}
        writable={writable}
        defaultSection={openSection}
        onBack={() => setRecordId(null)}
        onSaved={refresh}
        onDelete={() => setDeleteTarget(alarm)}
        onChannelsChanged={refreshChannels}
      />
      {confirmDialog}
    </>;
  }

  const columns = [
    {
      key: "name",
      header: "Alarm",
      render: (alarm) => <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate font-medium text-foreground">{alarm.name}</span>
        <span className="truncate font-mono text-xs text-text-secondary">{conditionOf(alarm)}</span>
      </div>,
    },
    {
      key: "state",
      header: "State",
      render: (alarm) => <div className="flex flex-wrap items-center gap-1.5">
        <StatusPill status={alarm.state} map={STATE_MAP} />
        {alarm.enabled === false ? <Badge variant="outline">Disabled</Badge> : null}
      </div>,
    },
    { key: "reason", header: "Reason", render: (alarm) => <span className="line-clamp-2 max-w-xs text-sm text-text-secondary">{alarm.stateReason || "—"}</span> },
    { key: "updated", header: "State changed", align: "right", className: "text-right", render: (alarm) => <span className="text-sm tabular-nums text-text-secondary">{formatDate(alarm.stateUpdatedAt)}</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (alarm) => <ActionMenu
        label={`Actions for ${alarm.name}`}
        items={[
          { icon: Pencil, label: writable ? "Edit" : "Open", onSelect: () => openAlarm(alarm) },
          { icon: History, label: "View history", onSelect: () => openAlarm(alarm, "history") },
          writable && { icon: alarm.enabled === false ? BellRing : BellOff, label: alarm.enabled === false ? "Enable" : "Disable", onSelect: () => toggleEnabled(alarm) },
          writable && { separator: true },
          writable && { icon: Trash2, label: "Delete", destructive: true, onSelect: () => setDeleteTarget(alarm) },
        ]}
      />,
    },
  ];

  const createButton = writable ? <Button className={PRIMARY} onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New Alarm</Button> : null;

  return <MainScreenWrapper>
    <ScreenHeader
      title="Alarms"
      description="Get notified when a gateway metric crosses a threshold for M of the last N periods. Each state change notifies exactly once."
      actions={createButton}
    />

    <StatsBar stats={stats} />

    <Toolbar>
      <div className="flex flex-wrap items-center gap-2">
        <FilterDropdown label="State" value={stateFilter} onValueChange={setStateFilter} options={STATE_FILTER_OPTIONS} height="h-9" />
      </div>
      <SearchInput value={search} onChange={setSearch} placeholder="Search alarms, metrics…" />
    </Toolbar>

    {state.status === "loading" ? <LoadingArea label="Loading alarms" /> : state.status === "error" ? <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={BellRing}
      title="Alarms unavailable"
      description={state.error}
      action={<Button variant="outline" className={SECONDARY} onClick={() => { setState({ status: "loading", items: [], error: null }); refresh(); }}>Retry</Button>}
    /></div> : <div className="space-y-5">
      <DataTable
        columns={columns}
        data={pager.pageItems}
        getRowKey={(alarm) => alarm.id}
        onRowClick={(alarm) => openAlarm(alarm)}
        empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
          icon={BellRing}
          title={alarms.length ? "No alarms match your filters" : "No alarms yet"}
          description={alarms.length
            ? "Try clearing the search or state filter."
            : "Create one to get notified when a metric breaches its threshold."}
          action={alarms.length ? null : createButton}
        /></div>}
      />
      <ListPagination {...pager} itemLabel="alarms" />
    </div>}

    {writable ? <CreateAlarmDialog open={creating} onOpenChange={setCreating} onCreated={refresh} /> : null}
    {confirmDialog}
  </MainScreenWrapper>;
}

function toDraft(alarm) {
  return {
    name: alarm.name ?? "",
    description: alarm.description ?? "",
    metric: alarm.metric ?? "",
    statistic: alarm.statistic ?? "Average",
    comparison: alarm.comparison ?? ">",
    threshold: String(alarm.threshold ?? ""),
    periodSec: String(alarm.periodSec ?? 300),
    evaluationPeriods: String(alarm.evaluationPeriods ?? 1),
    datapointsToAlarm: String(alarm.datapointsToAlarm ?? alarm.evaluationPeriods ?? 1),
    treatMissingData: alarm.treatMissingData ?? "missing",
    enabled: alarm.enabled !== false,
    actions: {
      ok: alarm.actions?.ok ?? [],
      alarm: alarm.actions?.alarm ?? [],
      insufficientData: alarm.actions?.insufficientData ?? [],
    },
  };
}

const NAV = [{
  group: null,
  items: [
    { key: "condition", label: "Condition", icon: Gauge, desc: "The metric to watch and when it counts as breaching." },
    { key: "notifications", label: "Notifications", icon: BellRing, desc: "Channels told about each state change." },
    { key: "history", label: "History", icon: History, desc: "State transitions with their reasons, newest first." },
  ],
}];

function AlarmEditPage({ alarm, channels, writable, defaultSection, onBack, onSaved, onDelete, onChannelsChanged }) {
  const { project } = useProject();
  const [draft, setDraft] = useState(() => toDraft(alarm));
  const [saving, setSaving] = useState(false);
  const set = (key) => (value) => setDraft((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    const name = draft.name.trim();
    if (!name) {
      toast.error("Give your alarm a name first.");
      return;
    }
    setSaving(true);
    try {
      await request(project.id, alarmPath(alarm.id), {
        method: "PATCH",
        body: JSON.stringify({
          name,
          description: draft.description,
          metric: draft.metric,
          statistic: draft.statistic,
          comparison: draft.comparison,
          threshold: Number(draft.threshold),
          periodSec: Number(draft.periodSec),
          evaluationPeriods: Number(draft.evaluationPeriods),
          datapointsToAlarm: Number(draft.datapointsToAlarm),
          treatMissingData: draft.treatMissingData,
          actions: draft.actions,
          enabled: draft.enabled,
        }),
      });
      toast.success("Saved.");
      await onSaved();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  return <EditorShell
    back={{ label: "All Alarms", onClick: onBack }}
    title={writable
      ? <InlineTitleInput
        value={draft.name}
        onChange={(event) => set("name")(event.target.value)}
        aria-label="Alarm name"
        placeholder="Untitled alarm"
        className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl"
      />
      : alarm.name}
    status={alarm.state}
    statusMap={STATE_MAP}
    meta={<span className="font-mono text-xs">{conditionOf(alarm)}</span>}
    actions={writable ? <>
      <label className="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-border bg-transparent px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface-active hover:text-foreground">
        {draft.enabled ? "Enabled" : "Disabled"}
        <Switch checked={draft.enabled} onCheckedChange={set("enabled")} />
      </label>
      <Button className={PRIMARY} disabled={saving} onClick={save}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {saving ? "Saving…" : "Save Changes"}
      </Button>
    </> : null}
    nav={NAV}
    defaultSection={defaultSection}
  >
    {({ active }) => {
      if (active === "notifications") {
        return <NotificationsSection draft={draft} setDraft={setDraft} channels={channels} writable={writable} onChannelsChanged={onChannelsChanged} />;
      }
      if (active === "history") return <HistorySection alarmId={alarm.id} />;
      return <div className="space-y-6">
        <SectionCard title="Condition" description="Breaching means the statistic compared against the threshold holds for M of the last N periods.">
          <div className="grid gap-4">
            <ConditionFields draft={draft} set={set} disabled={!writable} idPrefix="alarm-edit" />
            <Field label="Description (optional)" htmlFor="alarm-edit-description">
              <Textarea id="alarm-edit-description" rows={2} maxLength={1024} value={draft.description} onChange={(event) => set("description")(event.target.value)} disabled={!writable} />
            </Field>
          </div>
        </SectionCard>
        {alarm.stateReason ? <SectionCard title="Current state" description={`Since ${formatDate(alarm.stateUpdatedAt)}.`}>
          <div className="flex flex-wrap items-center gap-3">
            <StatusPill status={alarm.state} map={STATE_MAP} />
            <span className="text-sm text-text-secondary">{alarm.stateReason}</span>
          </div>
        </SectionCard> : null}
        {writable ? <SectionCard title="Danger zone" description="Deleting an alarm stops evaluation and removes its history.">
          <Button className="bg-red-500/90 text-white hover:bg-red-500" onClick={onDelete}><Trash2 className="h-4 w-4" />Delete Alarm</Button>
        </SectionCard> : null}
      </div>;
    }}
  </EditorShell>;
}

function NotificationsSection({ draft, setDraft, channels, writable, onChannelsChanged }) {
  const { project } = useProject();
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const toggle = (key, channelId, checked) => setDraft((prev) => {
    const current = prev.actions[key] ?? [];
    const next = checked ? [...new Set([...current, channelId])] : current.filter((id) => id !== channelId);
    return { ...prev, actions: { ...prev.actions, [key]: next } };
  });

  const deleteChannel = async (channel) => {
    try {
      await request(project.id, channelPath(channel.id), { method: "DELETE" });
      toast.success(`Deleted "${channel.name}".`);
      setDeleteTarget(null);
      // Drop the id from this alarm's draft so a save doesn't point at a dead channel.
      setDraft((prev) => ({
        ...prev,
        actions: Object.fromEntries(Object.entries(prev.actions).map(([key, ids]) => [key, ids.filter((id) => id !== channel.id)])),
      }));
      await onChannelsChanged();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const items = channels.items;
  const newChannelButton = writable ? <Button size="sm" className={PRIMARY} onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New Channel</Button> : null;

  const columns = [
    {
      key: "name",
      header: "Channel",
      render: (channel) => <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-card text-muted-foreground"><Webhook className="h-4 w-4" /></div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate font-medium text-foreground">{channel.name}</span>
          <span className="truncate font-mono text-xs text-text-secondary">{channelTarget(channel)}</span>
        </div>
      </div>,
    },
    { key: "type", header: "Type", render: (channel) => <Badge variant="neutral">{CHANNEL_LABEL[channel.type] ?? channel.type}</Badge> },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (channel) => (writable ? <ActionMenu
        label={`Actions for ${channel.name}`}
        items={[{ icon: Trash2, label: "Delete", destructive: true, onSelect: () => setDeleteTarget(channel) }]}
      /> : null),
    },
  ];

  return <div className="space-y-6">
    <SectionCard title="Notify on state change" description="Pick the channels that hear about each transition. Save Changes to apply.">
      {channels.status === "loading" ? <LoadingArea label="Loading channels" /> : items.length === 0 ? <p className="text-sm text-text-secondary">
        {channels.status === "error" ? "Channels couldn't be loaded." : `No notification channels yet${writable ? " — create one below." : "."}`}
      </p> : <div className="divide-y divide-border">
        {NOTIFY_STATES.map((entry) => <div key={entry.key} className="flex flex-col gap-3 py-3.5 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <StatusPill status={entry.state} map={STATE_MAP} />
              <p className="text-sm font-medium text-foreground">{entry.title}</p>
            </div>
            <p className="mt-1 text-xs text-text-secondary">{entry.description}</p>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2 sm:justify-end">
            {items.map((channel) => {
              const id = `notify-${entry.key}-${channel.id}`;
              return <label key={channel.id} htmlFor={id} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                <Checkbox
                  id={id}
                  checked={(draft.actions[entry.key] ?? []).includes(channel.id)}
                  onCheckedChange={(value) => toggle(entry.key, channel.id, value === true)}
                  disabled={!writable}
                />
                {channel.name}
              </label>;
            })}
          </div>
        </div>)}
      </div>}
    </SectionCard>

    <SectionCard title="Notification channels" description="Shared by every alarm in this project." action={newChannelButton}>
      {channels.status === "loading" ? <LoadingArea label="Loading channels" /> : channels.status === "error" ? <EmptyState
        icon={Webhook}
        title="Channels unavailable"
        description={channels.error}
        action={<Button variant="outline" className={SECONDARY} onClick={onChannelsChanged}>Retry</Button>}
      /> : <DataTable
        columns={columns}
        data={items}
        getRowKey={(channel) => channel.id}
        empty={<EmptyState
          icon={Webhook}
          title="No channels yet"
          description="Webhooks, Slack webhooks and email addresses that alarms can notify."
          action={newChannelButton}
        />}
      />}
    </SectionCard>

    {writable ? <CreateChannelDialog open={creating} onOpenChange={setCreating} onCreated={onChannelsChanged} /> : null}
    {writable ? <ConfirmDeleteDialog
      target={deleteTarget}
      kind="channel"
      consequence="Alarms that notify it stop sending there."
      onCancel={() => setDeleteTarget(null)}
      onConfirm={deleteChannel}
    /> : null}
  </div>;
}

function HistorySection({ alarmId }) {
  const { project } = useProject();
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState({ key: null, status: "loading", items: [], error: null });
  const key = `${alarmId}|${nonce}`;

  useEffect(() => {
    let alive = true;
    request(project.id, `${alarmPath(alarmId)}/history`).then(
      (data) => { if (alive) setState({ key, status: "ready", items: Array.isArray(data) ? data : data?.items ?? [], error: null }); },
      (error) => { if (alive) setState({ key, status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id, alarmId, key]);

  if (state.key !== key) return <LoadingArea label="Loading history" />;
  if (state.status === "error") {
    return <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={History}
      title="History unavailable"
      description={state.error}
      action={<Button variant="outline" className={SECONDARY} onClick={() => setNonce((value) => value + 1)}>Retry</Button>}
    /></div>;
  }

  const columns = [
    { key: "time", header: "Time", render: (entry) => <span className="text-sm tabular-nums text-text-secondary">{formatDate(entry.createdAt ?? entry.created_at)}</span> },
    {
      key: "transition",
      header: "Transition",
      render: (entry) => <div className="flex flex-wrap items-center gap-1.5">
        <StatusPill status={entry.fromState ?? entry.from_state} map={STATE_MAP} />
        <span className="text-text-tertiary">→</span>
        <StatusPill status={entry.toState ?? entry.to_state} map={STATE_MAP} />
      </div>,
    },
    { key: "reason", header: "Reason", render: (entry) => <span className="text-sm text-text-secondary">{entry.reason || "—"}</span> },
  ];

  return <DataTable
    columns={columns}
    data={state.items}
    getRowKey={(entry, index) => entry.id ?? index}
    empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={History}
      title="No transitions yet"
      description="State changes show up here once the alarm is evaluated."
    /></div>}
  />;
}
