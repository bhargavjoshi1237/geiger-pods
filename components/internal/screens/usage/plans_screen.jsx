"use client";

// Usage plans: list and create, plus an editor per plan with Settings (name,
// throttle, quota), Stages (API stages + per-method throttles), API Keys
// (add/remove members) and Usage (per-key daily used/remaining, CSV export,
// extend/reset/set quota).

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, CalendarRange, Copy, Download, Gauge, KeyRound, Layers, Loader2, Pencil, Plus, Settings, SlidersHorizontal, Trash2,
} from "lucide-react";
import {
  DataTable,
  EmptyState,
  Field,
  LoadingArea,
  ScreenHeader,
  SearchInput,
  SectionCard,
  StatsBar,
  StatusPill,
  Toolbar,
} from "@/components/internal/shared/screen_kit";
import { MainScreenWrapper } from "@/components/internal/shared/screen_wrappers";
import { ListPagination, usePagination } from "@/components/internal/shared/pagination";
import { EditorHeader, EditorShell } from "@/components/internal/shared/editor_shell";
import FilterDropdown from "@/components/internal/screens/overview/filter_dropdown";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { useRecordParam } from "@/lib/hooks/use-record-param";

const PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";
const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";
const DANGER = "bg-red-500/90 text-white hover:bg-red-500";

const PERIODS = [
  { value: "DAY", label: "Day" },
  { value: "WEEK", label: "Week" },
  { value: "MONTH", label: "Month" },
];

const LIMIT_FILTER_OPTIONS = [
  { value: "all", label: "All Limits" },
  { value: "throttle", label: "Throttled" },
  { value: "quota", label: "With quota" },
  { value: "none", label: "No limits" },
];

const KEY_STATUS_MAP = {
  enabled: { label: "Enabled", variant: "success", dotClass: "bg-emerald-400" },
  disabled: { label: "Disabled", variant: "neutral", dotClass: "bg-[#737373]" },
};

const ADJUST_OPS = [
  { value: "extend", label: "Extend — add requests to this period" },
  { value: "set", label: "Set — remaining requests this period" },
  { value: "reset", label: "Reset — back to the plan's quota" },
];

const NAV = [{
  group: null,
  items: [
    { key: "settings", label: "Settings", icon: Settings, desc: "Name, throttle and quota applied to every key in this plan." },
    { key: "stages", label: "Stages", icon: Layers, desc: "API stages this plan covers, with optional per-method throttles." },
    { key: "keys", label: "API Keys", icon: KeyRound, desc: "Keys that may call this plan's stages." },
    { key: "usage", label: "Usage", icon: Activity, desc: "Daily requests and remaining quota per key." },
  ],
}];

const EMPTY_LIMITS = { rate: "", burst: "", limit: "", period: "DAY", offset: "" };

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

const projectBase = (projectId) => `/api/v1/projects/${encodeURIComponent(projectId)}`;
const api = (projectId, path, options) => request(`${projectBase(projectId)}/usage-plans${path}`, options);
const apiKeys = (projectId, path, options) => request(`${projectBase(projectId)}/api-keys${path}`, options);
const apis = (projectId, path, options) => request(`${projectBase(projectId)}/apis${path}`, options);

const asText = (value) => (value === null || value === undefined ? "" : String(value));
const formatNumber = (value) => Number(value ?? 0).toLocaleString("en-US");
const formatDate = (value) => (value
  ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
  : "—");
const periodLabel = (period) => PERIODS.find((entry) => entry.value === period)?.label.toLowerCase() ?? String(period).toLowerCase();

function throttleSummary(plan) {
  return plan.throttle ? `${formatNumber(plan.throttle.rateLimit)} rps · ${formatNumber(plan.throttle.burstLimit)} burst` : null;
}

function quotaSummary(plan) {
  if (!plan.quota) return null;
  const base = `${formatNumber(plan.quota.limit)} / ${periodLabel(plan.quota.period)}`;
  return plan.quota.offset ? `${base} (offset ${formatNumber(plan.quota.offset)})` : base;
}

function methodThrottleSummary(methodThrottles) {
  const entries = Object.entries(methodThrottles ?? {});
  if (entries.length === 0) return "Plan throttle only";
  return entries.map(([key, entry]) => `${key} ${entry.rateLimit}/${entry.burstLimit}`).join(", ");
}

function copyText(value, message = "Copied.") {
  navigator.clipboard?.writeText(value).then(
    () => toast.success(message),
    () => toast.error("Couldn't copy to the clipboard."),
  );
}

function limitsDraft(plan) {
  return {
    rate: asText(plan.throttle?.rateLimit),
    burst: asText(plan.throttle?.burstLimit),
    limit: asText(plan.quota?.limit),
    period: plan.quota?.period ?? "DAY",
    offset: plan.quota?.offset ? String(plan.quota.offset) : "",
  };
}

// Blank throttle/quota fields mean "none": `absent` is undefined on create and
// null on update (which clears the setting).
function limitsPayload(draft, absent) {
  const throttle = draft.rate.trim() !== "" || draft.burst.trim() !== ""
    ? { rateLimit: Number(draft.rate || 0), burstLimit: Number(draft.burst || 0) }
    : absent;
  const quota = draft.limit.trim() !== ""
    ? { limit: Number(draft.limit), period: draft.period, offset: Number(draft.offset || 0) }
    : absent;
  return { throttle, quota };
}

function ThrottleFields({ draft, set, idPrefix, readOnly = false }) {
  return <div className="grid grid-cols-2 gap-4">
    <Field label="Rate (requests/sec)" htmlFor={`${idPrefix}-rate`}>
      <Input id={`${idPrefix}-rate`} inputMode="decimal" value={draft.rate} onChange={(event) => set("rate", event.target.value)} placeholder="No throttle" readOnly={readOnly} />
    </Field>
    <Field label="Burst" htmlFor={`${idPrefix}-burst`}>
      <Input id={`${idPrefix}-burst`} inputMode="numeric" value={draft.burst} onChange={(event) => set("burst", event.target.value)} placeholder="No throttle" readOnly={readOnly} />
    </Field>
  </div>;
}

function QuotaFields({ draft, set, idPrefix, readOnly = false }) {
  return <div className="grid grid-cols-3 gap-4">
    <Field label="Limit (requests)" htmlFor={`${idPrefix}-limit`}>
      <Input id={`${idPrefix}-limit`} inputMode="numeric" value={draft.limit} onChange={(event) => set("limit", event.target.value)} placeholder="No quota" readOnly={readOnly} />
    </Field>
    <Field label="Period" htmlFor={`${idPrefix}-period`}>
      <Select value={draft.period} onValueChange={(value) => set("period", value)} disabled={readOnly}>
        <SelectTrigger id={`${idPrefix}-period`} className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          {PERIODS.map((period) => <SelectItem key={period.value} value={period.value}>{period.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </Field>
    <Field label="Offset" htmlFor={`${idPrefix}-offset`}>
      <Input id={`${idPrefix}-offset`} inputMode="numeric" value={draft.offset} onChange={(event) => set("offset", event.target.value)} placeholder="0" readOnly={readOnly} />
    </Field>
  </div>;
}

function CreatePlanDialog({ open, onOpenChange, busy, onCreate }) {
  const [draft, setDraft] = useState({ name: "", description: "", ...EMPTY_LIMITS });
  const set = (field, value) => setDraft((current) => ({ ...current, [field]: value }));

  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setDraft({ name: "", description: "", ...EMPTY_LIMITS });
  }

  const submit = () => {
    if (!draft.name.trim()) {
      toast.error("Give your plan a name first.");
      return;
    }
    onCreate(draft);
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-xl bg-background">
      <DialogHeader>
        <DialogTitle>Create Usage Plan</DialogTitle>
        <DialogDescription>Set the limits now — you&apos;ll attach API stages and keys on the plan&apos;s edit page. Limits can&apos;t exceed the project throttle (10,000 rps / 5,000 burst by default).</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <Field label="Name" htmlFor="plan-name">
          <Input
            id="plan-name"
            value={draft.name}
            onChange={(event) => set("name", event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submit(); } }}
            placeholder="e.g. Basic tier"
            maxLength={128}
            autoFocus
          />
        </Field>
        <Field label="Description (optional)" htmlFor="plan-desc">
          <Input id="plan-desc" value={draft.description} onChange={(event) => set("description", event.target.value)} maxLength={1024} />
        </Field>
        <ThrottleFields draft={draft} set={set} idPrefix="plan-create" />
        <QuotaFields draft={draft} set={set} idPrefix="plan-create" />
      </div>
      <DialogFooter>
        <Button variant="outline" className={SECONDARY} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button className={PRIMARY} disabled={busy} onClick={submit}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Create Usage Plan
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

// Delete/remove confirmation. `target` = { title, subject, consequence,
// confirmLabel, onConfirm }, or a full `description` node instead of
// subject + consequence.
function ConfirmDialog({ target, busy, onCancel }) {
  return <Dialog open={!!target} onOpenChange={(open) => { if (!open) onCancel(); }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{target?.title}</DialogTitle>
        <DialogDescription>
          {target?.description ?? <>
            Are you sure you want to delete{" "}
            <span className="font-medium text-foreground">{target?.subject}</span>? {target?.consequence}
          </>}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button className={DANGER} disabled={busy} onClick={() => target?.onConfirm()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}{target?.confirmLabel ?? "Delete"}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function UsagePlansScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [recordId, setRecordId] = useRecordParam();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [search, setSearch] = useState("");
  const [limits, setLimits] = useState("all");
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const writable = can("pods.usage_plan.write");

  const refresh = useCallback(async () => {
    try {
      const data = await api(project.id, "");
      setState({ status: "ready", items: data.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [project.id]);

  useEffect(() => {
    let alive = true;
    api(project.id, "").then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id]);

  const plans = state.items;

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return plans.filter((plan) => {
      if (limits === "throttle" && !plan.throttle) return false;
      if (limits === "quota" && !plan.quota) return false;
      if (limits === "none" && (plan.throttle || plan.quota)) return false;
      return !query || `${plan.name} ${plan.description ?? ""} ${plan.publicId ?? ""}`.toLowerCase().includes(query);
    });
  }, [plans, search, limits]);

  const pager = usePagination(filtered, { resetKey: `${search}|${limits}` });

  const stats = useMemo(() => [
    { label: "Total plans", value: String(plans.length), footer: "Across this project" },
    { label: "Throttled", value: String(plans.filter((plan) => plan.throttle).length), footer: "Rate and burst limits" },
    { label: "With quota", value: String(plans.filter((plan) => plan.quota).length), footer: "Requests per period" },
    { label: "No limits", value: String(plans.filter((plan) => !plan.throttle && !plan.quota).length), footer: "Project throttle only" },
  ], [plans]);

  const create = async (draft) => {
    setBusy(true);
    try {
      const { throttle, quota } = limitsPayload(draft, undefined);
      const created = await api(project.id, "", {
        method: "POST",
        body: JSON.stringify({ name: draft.name.trim(), description: draft.description, throttle, quota }),
      });
      toast.success(`"${created.name ?? draft.name.trim()}" created.`);
      setCreating(false);
      await refresh();
      if (created?.id) setRecordId(created.id);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (plan) => {
    setBusy(true);
    try {
      await api(project.id, `/${encodeURIComponent(plan.id)}`, { method: "DELETE" });
      toast.success(`Deleted "${plan.name}".`);
      setDeleteTarget(null);
      if (recordId) setRecordId(null);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const deleteDialog = <ConfirmDialog
    target={deleteTarget ? {
      title: "Delete usage plan",
      subject: deleteTarget.name,
      consequence: "Its keys lose access to the plan's stages. This action can't be undone.",
      onConfirm: () => remove(deleteTarget),
    } : null}
    busy={busy}
    onCancel={() => setDeleteTarget(null)}
  />;

  if (recordId) {
    return <>
      <PlanEditor
        key={recordId}
        planId={recordId}
        writable={writable}
        onBack={() => setRecordId(null)}
        onListChanged={refresh}
        onRequestDelete={setDeleteTarget}
      />
      {deleteDialog}
    </>;
  }

  const columns = [
    {
      key: "name",
      header: "Plan",
      render: (plan) => <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-card text-muted-foreground">
          <Gauge className="h-4 w-4" />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate font-medium text-foreground">{plan.name}</span>
          <span className="block max-w-[26rem] truncate text-xs text-text-secondary">{plan.description || "No description"}</span>
        </div>
      </div>,
    },
    { key: "throttle", header: "Throttle", render: (plan) => <span className="text-sm tabular-nums text-text-secondary">{throttleSummary(plan) ?? "—"}</span> },
    { key: "quota", header: "Quota", render: (plan) => <span className="text-sm tabular-nums text-text-secondary">{quotaSummary(plan) ?? "No quota"}</span> },
    { key: "id", header: "Plan ID", render: (plan) => <span className="font-mono text-xs text-text-secondary">{plan.publicId}</span> },
    { key: "updated", header: "Updated", render: (plan) => <span className="text-sm tabular-nums text-text-secondary">{formatDate(plan.updatedAt ?? plan.createdAt)}</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (plan) => <ActionMenu
        label={`Actions for ${plan.name}`}
        items={[
          { icon: Pencil, label: writable ? "Edit" : "Open", onSelect: () => setRecordId(plan.id) },
          { icon: Copy, label: "Copy plan ID", onSelect: () => copyText(plan.publicId ?? plan.id) },
          writable && { separator: true },
          writable && { icon: Trash2, label: "Delete", variant: "destructive", onSelect: () => setDeleteTarget(plan) },
        ]}
      />,
    },
  ];

  const createButton = writable
    ? <Button className={PRIMARY} onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New Usage Plan</Button>
    : null;

  return <MainScreenWrapper>
    <ScreenHeader
      title="Usage Plans"
      description="Throttles and quotas for your API stages, and the API keys allowed to call them."
      actions={createButton}
    />

    <StatsBar stats={stats} />

    <Toolbar>
      <div className="flex flex-wrap items-center gap-2">
        <FilterDropdown label="Limits" value={limits} onValueChange={setLimits} options={LIMIT_FILTER_OPTIONS} height="h-9" />
      </div>
      <SearchInput value={search} onChange={setSearch} placeholder="Search usage plans…" />
    </Toolbar>

    {state.status === "loading" ? <LoadingArea panel label="Loading usage plans" /> : null}
    {state.status === "error" ? <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={Gauge}
      title="Usage plans unavailable"
      description={state.error}
      action={<Button variant="outline" onClick={() => { setState({ status: "loading", items: [], error: null }); refresh(); }}>Retry</Button>}
    /></div> : null}
    {state.status === "ready" ? <div className="space-y-5">
      <DataTable
        columns={columns}
        data={pager.pageItems}
        getRowKey={(plan) => plan.id}
        onRowClick={(plan) => setRecordId(plan.id)}
        empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
          icon={Gauge}
          title={plans.length ? "No usage plans match your filters" : "No usage plans yet"}
          description={plans.length
            ? "Try clearing the search or limits filter."
            : "Plans bind API stages to throttles, quotas and the API keys allowed to call them."}
          action={plans.length ? null : createButton}
        /></div>}
      />
      <ListPagination {...pager} itemLabel="usage plans" />
    </div> : null}

    {writable ? <CreatePlanDialog open={creating} onOpenChange={setCreating} busy={busy} onCreate={create} /> : null}
    {deleteDialog}
  </MainScreenWrapper>;
}

function PlanEditor({ planId, writable, onBack, onListChanged, onRequestDelete }) {
  const { project } = useProject();
  const [state, setState] = useState({ status: "loading", plan: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const back = { label: "All Usage Plans", onClick: onBack };

  useEffect(() => {
    let alive = true;
    api(project.id, `/${encodeURIComponent(planId)}`).then(
      (plan) => { if (alive) setState({ status: "ready", plan, error: null }); },
      (error) => { if (alive) setState({ status: "error", plan: null, error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id, planId, attempt]);

  const reload = useCallback(async () => {
    try {
      const plan = await api(project.id, `/${encodeURIComponent(planId)}`);
      setState({ status: "ready", plan, error: null });
    } catch {
      // Keep showing the last good copy; the next action retries.
    }
  }, [project.id, planId]);

  if (state.status === "loading") return <LoadingArea label="Loading usage plan" />;
  if (state.status === "error") {
    return <MainScreenWrapper>
      <EditorHeader back={back} title="Usage plan unavailable" />
      <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
        icon={Gauge}
        title="Usage plan unavailable"
        description={state.error}
        action={<Button variant="outline" onClick={() => { setState({ status: "loading", plan: null, error: null }); setAttempt((value) => value + 1); }}>Retry</Button>}
      /></div>
    </MainScreenWrapper>;
  }
  return <PlanEditorBody
    plan={state.plan}
    projectId={project.id}
    writable={writable}
    back={back}
    onChanged={async () => { await reload(); await onListChanged(); }}
    onRequestDelete={onRequestDelete}
  />;
}

function PlanEditorBody({ plan, projectId, writable, back, onChanged, onRequestDelete }) {
  const [section, setSection] = useState("settings");
  const [draft, setDraft] = useState(() => ({ name: plan.name ?? "", description: plan.description ?? "", ...limitsDraft(plan) }));
  const [saving, setSaving] = useState(false);
  // Which section-level dialog is open: "stage" | "key" | "adjust" | null.
  const [dialog, setDialog] = useState(null);
  const set = (field, value) => setDraft((current) => ({ ...current, [field]: value }));

  const save = async () => {
    if (!draft.name.trim()) {
      toast.error("Give your plan a name first.");
      return;
    }
    setSaving(true);
    try {
      const { throttle, quota } = limitsPayload(draft, null);
      await api(projectId, `/${encodeURIComponent(plan.id)}`, {
        method: "PATCH",
        headers: { "If-Match": String(plan.version) },
        body: JSON.stringify({ name: draft.name.trim(), description: draft.description, throttle, quota }),
      });
      toast.success("Saved. Gateways pick it up without a redeploy.");
      await onChanged();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const sectionAction = {
    stages: writable ? <Button variant="outline" className={SECONDARY} onClick={() => setDialog("stage")}><Plus className="h-4 w-4" /> Add Stage</Button> : null,
    keys: writable ? <Button variant="outline" className={SECONDARY} onClick={() => setDialog("key")}><Plus className="h-4 w-4" /> Add API Key</Button> : null,
    usage: writable && plan.quota ? <Button variant="outline" className={SECONDARY} onClick={() => setDialog("adjust")}><SlidersHorizontal className="h-4 w-4" /> Adjust Quota</Button> : null,
  }[section] ?? null;

  const sectionProps = { plan, projectId, writable, dialog, setDialog, onChanged };

  return <EditorShell
    back={back}
    title={plan.name}
    badges={<>
      <span className="font-mono text-xs text-text-secondary">{plan.publicId}</span>
      <Badge variant="outline">{plan.keyCount ?? 0} key{plan.keyCount === 1 ? "" : "s"}</Badge>
      <Badge variant="outline">{(plan.stages ?? []).length} stage{(plan.stages ?? []).length === 1 ? "" : "s"}</Badge>
    </>}
    meta={plan.description || undefined}
    actions={writable ? <Button className={PRIMARY} disabled={saving} onClick={save}>
      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
      {saving ? "Saving…" : "Save Changes"}
    </Button> : null}
    nav={NAV}
    active={section}
    onActiveChange={setSection}
    sectionAction={sectionAction}
  >
    {({ active }) => {
      if (active === "stages") return <PlanStagesSection {...sectionProps} />;
      if (active === "keys") return <PlanKeysSection {...sectionProps} />;
      if (active === "usage") return <PlanUsageSection {...sectionProps} />;
      return <PlanSettingsSection draft={draft} set={set} writable={writable} onDelete={() => onRequestDelete(plan)} />;
    }}
  </EditorShell>;
}

function PlanSettingsSection({ draft, set, writable, onDelete }) {
  return <div className="space-y-6">
    <SectionCard title="Details" description="How this plan appears in lists, usage reports and the audit log.">
      <div className="grid gap-4">
        <Field label="Name" htmlFor="plan-edit-name">
          <Input id="plan-edit-name" value={draft.name} onChange={(event) => set("name", event.target.value)} maxLength={128} readOnly={!writable} />
        </Field>
        <Field label="Description" htmlFor="plan-edit-description">
          <Textarea id="plan-edit-description" value={draft.description} onChange={(event) => set("description", event.target.value)} rows={2} maxLength={1024} readOnly={!writable} />
        </Field>
      </div>
    </SectionCard>

    <SectionCard title="Throttle" description="Steady-state rate and burst for each key. Leave both empty for no plan throttle. Can't exceed the project throttle.">
      <ThrottleFields draft={draft} set={set} idPrefix="plan-edit" readOnly={!writable} />
    </SectionCard>

    <SectionCard title="Quota" description="Requests each key may make per period. Leave the limit empty for no quota; the offset is subtracted from the limit in the first period.">
      <QuotaFields draft={draft} set={set} idPrefix="plan-edit" readOnly={!writable} />
    </SectionCard>

    {writable ? <div className="rounded-xl border border-red-500/30 p-4">
      <p className="text-sm font-semibold text-red-400">Danger zone</p>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-4 border-t border-red-500/20 pt-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Delete this usage plan</p>
          <p className="text-xs text-text-secondary">Its keys lose access to the plan&apos;s stages. This can&apos;t be undone.</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="border-red-500/40 bg-transparent text-red-400 hover:bg-red-500/10 hover:text-red-400"
          onClick={onDelete}
        ><Trash2 className="h-4 w-4" />Delete Usage Plan</Button>
      </div>
    </div> : null}
  </div>;
}

function parseMethodThrottles(text) {
  try {
    return { ok: true, value: JSON.parse(text.trim() || "{}") };
  } catch {
    toast.error("Method throttles must be valid JSON.");
    return { ok: false, value: null };
  }
}

function MethodThrottlesField({ id, value, onChange }) {
  return <Field label="Method throttles (JSON)" htmlFor={id} hint={'Keys are "/path/METHOD", values {"rateLimit", "burstLimit"}. Up to 20.'}>
    <Textarea id={id} className="min-h-28 font-mono text-xs" value={value} onChange={(event) => onChange(event.target.value)} spellCheck={false} />
  </Field>;
}

function PlanStagesSection({ plan, projectId, writable, dialog, setDialog, onChanged }) {
  const [apiList, setApiList] = useState({ status: "loading", items: [] });
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    apis(projectId, "").then(
      (data) => { if (alive) setApiList({ status: "ready", items: data.items ?? [] }); },
      () => { if (alive) setApiList({ status: "error", items: [] }); },
    );
    return () => { alive = false; };
  }, [projectId]);

  const apiFor = (apiId) => apiList.items.find((entry) => entry.id === apiId || entry.publicId === apiId) ?? null;

  const mutate = async (method, body, success) => {
    setBusy(true);
    try {
      await api(projectId, `/${encodeURIComponent(plan.id)}/stages`, { method, body: JSON.stringify(body) });
      toast.success(success);
      await onChanged();
      return true;
    } catch (error) {
      toast.error(error.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const stages = plan.stages ?? [];
  const addButton = writable ? <Button variant="outline" className={SECONDARY} onClick={() => setDialog("stage")}><Plus className="h-4 w-4" /> Add Stage</Button> : null;

  const columns = [
    {
      key: "api",
      header: "API",
      render: (stage) => {
        const entry = apiFor(stage.apiId);
        return <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate font-medium text-foreground">{entry?.name ?? String(stage.apiId).slice(0, 8)}</span>
          <span className="truncate font-mono text-xs text-text-secondary">{entry?.publicId ?? stage.apiId}</span>
        </div>;
      },
    },
    { key: "stage", header: "Stage", render: (stage) => <Badge variant="neutral">{stage.stage}</Badge> },
    { key: "methods", header: "Method throttles", render: (stage) => <span className="text-sm text-text-secondary">{methodThrottleSummary(stage.methodThrottles)}</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (stage) => <ActionMenu
        label={`Actions for stage ${stage.stage}`}
        items={writable ? [
          { icon: SlidersHorizontal, label: "Method throttles", onSelect: () => setEditing(stage) },
          { separator: true },
          { icon: Trash2, label: "Remove", variant: "destructive", onSelect: () => setRemoving(stage) },
        ] : []}
      />,
    },
  ];

  return <>
    <DataTable
      columns={columns}
      data={stages}
      getRowKey={(stage) => `${stage.apiId}:${stage.stage}`}
      onRowClick={writable ? setEditing : undefined}
      empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
        icon={Layers}
        title="No stages yet"
        description="Add an API stage so keys in this plan can call it. Usage plans work with REST and WebSocket APIs."
        action={addButton}
      /></div>}
    />

    {writable ? <AddStageDialog
      open={dialog === "stage"}
      onOpenChange={(open) => setDialog(open ? "stage" : null)}
      projectId={projectId}
      apiList={apiList}
      busy={busy}
      onAdd={async (body) => { if (await mutate("POST", body, "Stage added.")) setDialog(null); }}
    /> : null}

    <MethodThrottlesDialog
      stage={editing}
      label={editing ? `${apiFor(editing.apiId)?.name ?? String(editing.apiId).slice(0, 8)} · ${editing.stage}` : ""}
      busy={busy}
      onClose={() => setEditing(null)}
      onSave={async (methodThrottles) => {
        if (await mutate("PATCH", { apiId: editing.apiId, stage: editing.stage, methodThrottles }, "Method throttles saved.")) setEditing(null);
      }}
    />

    <ConfirmDialog
      target={removing ? {
        title: "Remove stage",
        description: <>
          Remove{" "}
          <span className="font-medium text-foreground">{apiFor(removing.apiId)?.name ?? String(removing.apiId).slice(0, 8)} · {removing.stage}</span>{" "}
          from this plan? Keys in the plan can no longer call it.
        </>,
        confirmLabel: "Remove",
        onConfirm: async () => {
          if (await mutate("DELETE", { apiId: removing.apiId, stage: removing.stage }, "Stage removed.")) setRemoving(null);
        },
      } : null}
      busy={busy}
      onCancel={() => setRemoving(null)}
    />
  </>;
}

function AddStageDialog({ open, onOpenChange, projectId, apiList, busy, onAdd }) {
  const [apiId, setApiId] = useState("");
  const [stage, setStage] = useState("");
  const [methods, setMethods] = useState("{}");
  const [stageList, setStageList] = useState({ apiId: null, status: "idle", items: [] });

  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setApiId("");
      setStage("");
      setMethods("{}");
      setStageList({ apiId: null, status: "idle", items: [] });
    }
  }

  // HTTP APIs can't join usage plans, so they aren't offered.
  const choices = apiList.items.filter((entry) => entry.protocol !== "HTTP");
  const manual = apiList.status === "error";

  const pickApi = (id) => {
    setApiId(id);
    setStage("");
    const entry = choices.find((candidate) => candidate.id === id);
    if (!entry) return;
    setStageList({ apiId: id, status: "loading", items: [] });
    apis(projectId, `/${encodeURIComponent(entry.publicId ?? entry.id)}/stages`).then(
      (data) => setStageList((current) => (current.apiId === id ? { apiId: id, status: "ready", items: data.items ?? [] } : current)),
      () => setStageList((current) => (current.apiId === id ? { apiId: id, status: "error", items: [] } : current)),
    );
  };

  const submit = () => {
    if (!apiId.trim() || !stage.trim()) {
      toast.error("Pick an API and a stage first.");
      return;
    }
    const parsed = parseMethodThrottles(methods);
    if (!parsed.ok) return;
    onAdd({ apiId: apiId.trim(), stage: stage.trim(), methodThrottles: parsed.value });
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-xl bg-background">
      <DialogHeader>
        <DialogTitle>Add Stage</DialogTitle>
        <DialogDescription>Keys in this plan can call the stage once it&apos;s added. Method throttles are optional and can&apos;t exceed the project throttle.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        {manual ? <div className="grid grid-cols-2 gap-4">
          <Field label="API ID" htmlFor="plan-stage-api">
            <Input id="plan-stage-api" className="font-mono text-xs" value={apiId} onChange={(event) => setApiId(event.target.value)} autoFocus />
          </Field>
          <Field label="Stage" htmlFor="plan-stage-name">
            <Input id="plan-stage-name" className="font-mono text-xs" value={stage} onChange={(event) => setStage(event.target.value)} />
          </Field>
        </div> : <div className="grid grid-cols-2 gap-4">
          <Field label="API" htmlFor="plan-stage-api">
            <Select value={apiId} onValueChange={pickApi} disabled={apiList.status === "loading"}>
              <SelectTrigger id="plan-stage-api" className="w-full">
                <SelectValue placeholder={apiList.status === "loading" ? "Loading APIs…" : choices.length ? "Select an API" : "No REST or WebSocket APIs"} />
              </SelectTrigger>
              <SelectContent>
                {choices.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Stage" htmlFor="plan-stage-name">
            <Select value={stage} onValueChange={setStage} disabled={!apiId || stageList.status !== "ready" || stageList.items.length === 0}>
              <SelectTrigger id="plan-stage-name" className="w-full">
                <SelectValue placeholder={!apiId
                  ? "Pick an API first"
                  : stageList.status === "loading" ? "Loading stages…"
                    : stageList.status === "error" ? "Stages unavailable"
                      : stageList.items.length ? "Select a stage" : "No stages yet"} />
              </SelectTrigger>
              <SelectContent>
                {stageList.items.map((entry) => <SelectItem key={entry.id ?? entry.name} value={entry.name}>{entry.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        </div>}
        <MethodThrottlesField id="plan-stage-methods" value={methods} onChange={setMethods} />
      </div>
      <DialogFooter>
        <Button variant="outline" className={SECONDARY} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button className={PRIMARY} disabled={busy} onClick={submit}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Add Stage
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function MethodThrottlesDialog({ stage, label, busy, onClose, onSave }) {
  const [text, setText] = useState("{}");
  const [prevStage, setPrevStage] = useState(stage);
  if (stage !== prevStage) {
    setPrevStage(stage);
    if (stage) setText(JSON.stringify(stage.methodThrottles ?? {}, null, 2));
  }

  const submit = () => {
    const parsed = parseMethodThrottles(text);
    if (parsed.ok) onSave(parsed.value);
  };

  return <Dialog open={!!stage} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-w-xl bg-background">
      <DialogHeader>
        <DialogTitle>Method Throttles</DialogTitle>
        <DialogDescription>Per-method limits for {label}. They replace the plan throttle for the methods listed.</DialogDescription>
      </DialogHeader>
      <MethodThrottlesField id="plan-stage-edit-methods" value={text} onChange={setText} />
      <DialogFooter>
        <Button variant="outline" className={SECONDARY} onClick={onClose}>Cancel</Button>
        <Button className={PRIMARY} disabled={busy} onClick={submit}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Save Changes
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function PlanKeysSection({ plan, projectId, writable, dialog, setDialog, onChanged }) {
  const [state, setState] = useState({ status: "loading", choices: [], members: [], error: null });
  const [attempt, setAttempt] = useState(0);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);

  // There's no plan-members endpoint, so membership comes from each key's detail.
  useEffect(() => {
    let alive = true;
    (async () => {
      let choices;
      try {
        choices = (await apiKeys(projectId, "")).items ?? [];
      } catch (error) {
        if (alive) setState({ status: "error", choices: [], members: [], error: error.message });
        return;
      }
      const members = [];
      for (const candidate of choices) {
        try {
          const detail = await apiKeys(projectId, `/${encodeURIComponent(candidate.id)}`);
          if ((detail.plans ?? []).some((entry) => entry.id === plan.id)) members.push(candidate);
        } catch {
          // Skip keys we can't read.
        }
      }
      if (alive) setState({ status: "ready", choices, members, error: null });
    })();
    return () => { alive = false; };
  }, [projectId, plan.id, plan.keyCount, attempt]);

  const mutate = async (method, keyId, success) => {
    setBusy(true);
    try {
      await api(projectId, `/${encodeURIComponent(plan.id)}/keys`, { method, body: JSON.stringify({ keyId }) });
      toast.success(success);
      await onChanged();
      return true;
    } catch (error) {
      toast.error(error.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addButton = writable ? <Button variant="outline" className={SECONDARY} onClick={() => setDialog("key")}><Plus className="h-4 w-4" /> Add API Key</Button> : null;

  const columns = [
    {
      key: "name",
      header: "Key",
      render: (key) => <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate font-medium text-foreground">{key.name}</span>
        <span className="block max-w-[26rem] truncate text-xs text-text-secondary">{key.customerId ? `Customer ${key.customerId}` : key.description || "No description"}</span>
      </div>,
    },
    { key: "prefix", header: "Value", render: (key) => <span className="font-mono text-xs text-text-secondary">…{key.prefix}</span> },
    { key: "status", header: "Status", render: (key) => <StatusPill status={key.enabled ? "enabled" : "disabled"} map={KEY_STATUS_MAP} /> },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (key) => <ActionMenu
        label={`Actions for ${key.name}`}
        items={[
          { icon: Copy, label: "Copy key ID", onSelect: () => copyText(key.publicId ?? key.id) },
          writable && { separator: true },
          writable && { icon: Trash2, label: "Remove from plan", variant: "destructive", onSelect: () => setRemoving(key) },
        ]}
      />,
    },
  ];

  return <>
    {state.status === "loading" ? <LoadingArea panel label="Loading API keys" /> : null}
    {state.status === "error" ? <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={KeyRound}
      title="API keys unavailable"
      description={state.error}
      action={<Button variant="outline" onClick={() => { setState({ status: "loading", choices: [], members: [], error: null }); setAttempt((value) => value + 1); }}>Retry</Button>}
    /></div> : null}
    {state.status === "ready" ? <DataTable
      columns={columns}
      data={state.members}
      getRowKey={(key) => key.id}
      empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
        icon={KeyRound}
        title="No keys in this plan yet"
        description="Add an API key so its callers can use this plan's stages."
        action={addButton}
      /></div>}
    /> : null}

    {writable ? <AddKeyDialog
      open={dialog === "key"}
      onOpenChange={(open) => setDialog(open ? "key" : null)}
      choices={state.status === "ready" ? state.choices.filter((key) => !state.members.some((member) => member.id === key.id)) : null}
      busy={busy}
      onAdd={async (keyId) => { if (await mutate("POST", keyId, "Key added.")) setDialog(null); }}
    /> : null}

    <ConfirmDialog
      target={removing ? {
        title: "Remove API key",
        description: <>
          Remove <span className="font-medium text-foreground">{removing.name}</span> from this plan? Its callers lose
          access to the plan&apos;s stages.
        </>,
        confirmLabel: "Remove",
        onConfirm: async () => { if (await mutate("DELETE", removing.id, "Key removed.")) setRemoving(null); },
      } : null}
      busy={busy}
      onCancel={() => setRemoving(null)}
    />
  </>;
}

// `choices` is null when the key list couldn't be read; the dialog then takes
// a pasted key ID instead.
function AddKeyDialog({ open, onOpenChange, choices, busy, onAdd }) {
  const [keyId, setKeyId] = useState("");
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setKeyId("");
  }

  const submit = () => {
    if (!keyId.trim()) {
      toast.error("Pick a key first.");
      return;
    }
    onAdd(keyId.trim());
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="bg-background sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Add API Key</DialogTitle>
        <DialogDescription>A key can belong to up to 10 plans, but not to two plans that cover the same API stage.</DialogDescription>
      </DialogHeader>
      {choices ? <Field label="API key" htmlFor="plan-add-key">
        <Select value={keyId} onValueChange={setKeyId}>
          <SelectTrigger id="plan-add-key" className="w-full">
            <SelectValue placeholder={choices.length ? "Select a key" : "Every key is already in this plan"} />
          </SelectTrigger>
          <SelectContent>
            {choices.map((key) => <SelectItem key={key.id} value={key.id}>{key.name} · …{key.prefix}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field> : <Field label="Key ID" htmlFor="plan-add-key" hint="The key's ID or public ID.">
        <Input id="plan-add-key" className="font-mono text-xs" value={keyId} onChange={(event) => setKeyId(event.target.value)} placeholder="Paste a key ID" autoFocus />
      </Field>}
      <DialogFooter>
        <Button variant="outline" className={SECONDARY} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button className={PRIMARY} disabled={busy || !keyId} onClick={submit}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Add API Key
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function initialUsageRange() {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { start: weekAgo, end: today };
}

function daysBetween(start, end) {
  const out = [];
  for (let day = start; day <= end; day = addOneDay(day)) out.push(day);
  return out;
}

function addOneDay(day) {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const USAGE_COLUMNS = [
  { key: "day", header: "Date", render: (row) => <span className="text-sm tabular-nums text-foreground">{row.day}</span> },
  { key: "used", header: "Used", align: "right", className: "tabular-nums", render: (row) => formatNumber(row.used) },
  { key: "remaining", header: "Remaining", align: "right", className: "tabular-nums text-text-secondary", render: (row) => formatNumber(row.remaining) },
];

function PlanUsageSection({ plan, projectId, writable, dialog, setDialog }) {
  const [range, setRange] = useState(initialUsageRange);
  // A fresh object per request, so asking for the same range again refetches.
  const [requested, setRequested] = useState(initialUsageRange);
  const [report, setReport] = useState({ status: "loading", usage: null, error: null });
  const [names, setNames] = useState({});
  const [adjusting, setAdjusting] = useState(false);

  useEffect(() => {
    let alive = true;
    api(projectId, `/${encodeURIComponent(plan.id)}/usage?startDate=${encodeURIComponent(requested.start)}&endDate=${encodeURIComponent(requested.end)}`).then(
      (usage) => { if (alive) setReport({ status: "ready", usage, error: null }); },
      (error) => { if (alive) setReport({ status: "error", usage: null, error: error.message }); },
    );
    return () => { alive = false; };
  }, [projectId, plan.id, requested]);

  // Reports are keyed by public key ID; names make them readable.
  useEffect(() => {
    let alive = true;
    apiKeys(projectId, "").then(
      (data) => { if (alive) setNames(Object.fromEntries((data.items ?? []).map((key) => [key.publicId, key.name]))); },
      () => {},
    );
    return () => { alive = false; };
  }, [projectId]);

  const load = () => {
    setReport({ status: "loading", usage: null, error: null });
    setRequested({ ...range });
  };

  const usage = report.usage;
  const entries = Object.entries(usage?.items ?? {});
  const days = usage ? daysBetween(usage.startDate, usage.endDate) : [];

  const exportCsv = () => {
    if (!usage) return;
    const lines = ["key,date,used,remaining"];
    for (const [keyId, pairs] of entries) {
      pairs.forEach(([used, remaining], index) => lines.push(`${keyId},${days[index] ?? ""},${used},${remaining}`));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `usage-${plan.publicId ?? plan.id}.csv`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  };

  const adjust = async ({ keyId, op, value }) => {
    setAdjusting(true);
    try {
      await api(projectId, `/${encodeURIComponent(plan.id)}/keys/${encodeURIComponent(keyId)}/usage`, {
        method: "PATCH",
        body: JSON.stringify({ op, ...(op === "reset" ? {} : { value: Number(value) }) }),
      });
      toast.success(`Usage ${op} applied.`);
      setDialog(null);
      setRequested((current) => ({ ...current }));
    } catch (error) {
      toast.error(error.message);
    } finally {
      setAdjusting(false);
    }
  };

  return <div className="space-y-6">
    <SectionCard
      title="Report"
      description="Today's numbers are live counters; earlier days come from rolled-up history."
      action={usage ? <Button variant="outline" size="sm" className={SECONDARY} onClick={exportCsv}><Download className="h-4 w-4" />Export CSV</Button> : null}
    >
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Start" htmlFor="plan-usage-start">
          <Input id="plan-usage-start" type="date" value={range.start} onChange={(event) => setRange({ ...range, start: event.target.value })} />
        </Field>
        <Field label="End" htmlFor="plan-usage-end">
          <Input id="plan-usage-end" type="date" value={range.end} onChange={(event) => setRange({ ...range, end: event.target.value })} />
        </Field>
        <Button variant="outline" className={SECONDARY} disabled={report.status === "loading"} onClick={load}>
          {report.status === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarRange className="h-4 w-4" />}Load Usage
        </Button>
      </div>
    </SectionCard>

    {report.status === "loading" ? <LoadingArea panel label="Loading usage" /> : null}
    {report.status === "error" ? <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={Activity}
      title="Usage unavailable"
      description={report.error}
      action={<Button variant="outline" onClick={load}>Retry</Button>}
    /></div> : null}
    {report.status === "ready" && entries.length === 0 ? <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={Activity}
      title="No traffic yet"
      description="Requests from this plan's keys show up here, one table per key."
    /></div> : null}
    {report.status === "ready" ? entries.map(([keyId, pairs]) => <div key={keyId} className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <p className="text-sm font-medium text-foreground">{names[keyId] ?? keyId}</p>
        {names[keyId] ? <span className="font-mono text-xs text-text-secondary">{keyId}</span> : null}
      </div>
      <DataTable
        columns={USAGE_COLUMNS}
        data={pairs.map(([used, remaining], index) => ({ day: days[index] ?? String(index), used, remaining }))}
        getRowKey={(row) => row.day}
      />
    </div>) : null}

    {writable ? <AdjustQuotaDialog
      open={dialog === "adjust"}
      onOpenChange={(open) => setDialog(open ? "adjust" : null)}
      keys={entries.map(([keyId]) => ({ id: keyId, name: names[keyId] }))}
      busy={adjusting}
      onApply={adjust}
    /> : null}
  </div>;
}

function AdjustQuotaDialog({ open, onOpenChange, keys, busy, onApply }) {
  const [draft, setDraft] = useState({ keyId: "", op: "extend", value: "10" });
  const set = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setDraft({ keyId: "", op: "extend", value: "10" });
  }

  const submit = () => {
    if (!draft.keyId.trim()) {
      toast.error("Pick a key first.");
      return;
    }
    onApply({ ...draft, keyId: draft.keyId.trim() });
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="bg-background sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Adjust Quota</DialogTitle>
        <DialogDescription>Changes one key&apos;s allowance for the current period only. The next period starts from the plan&apos;s quota again.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        {keys.length ? <Field label="API key" htmlFor="plan-adjust-key">
          <Select value={draft.keyId} onValueChange={(value) => set("keyId", value)}>
            <SelectTrigger id="plan-adjust-key" className="w-full"><SelectValue placeholder="Select a key" /></SelectTrigger>
            <SelectContent>
              {keys.map((key) => <SelectItem key={key.id} value={key.id}>{key.name ? `${key.name} · ${key.id}` : key.id}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field> : <Field label="Key public ID" htmlFor="plan-adjust-key">
          <Input id="plan-adjust-key" className="font-mono text-xs" value={draft.keyId} onChange={(event) => set("keyId", event.target.value)} autoFocus />
        </Field>}
        <Field label="Operation" htmlFor="plan-adjust-op">
          <Select value={draft.op} onValueChange={(value) => set("op", value)}>
            <SelectTrigger id="plan-adjust-op" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {ADJUST_OPS.map((op) => <SelectItem key={op.value} value={op.value}>{op.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        {draft.op !== "reset" ? <Field label="Requests" htmlFor="plan-adjust-value">
          <Input id="plan-adjust-value" inputMode="numeric" value={draft.value} onChange={(event) => set("value", event.target.value)} />
        </Field> : null}
      </div>
      <DialogFooter>
        <Button variant="outline" className={SECONDARY} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button className={PRIMARY} disabled={busy} onClick={submit}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Apply
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
