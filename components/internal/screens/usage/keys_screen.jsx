"use client";

// API keys: list, create (generated or custom value), import CSV, reveal
// (permission-gated, audited), enable/disable, rotate and delete. Key values
// only ever appear once after create/rotate or through the gated reveal — the
// list and the edit page carry metadata only.

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Copy, Eye, KeyRound, Loader2, Pencil, Plus, Power, PowerOff, RotateCw, Trash2, Upload } from "lucide-react";
import {
  DataTable,
  EmptyState,
  Field,
  LoadingArea,
  ScreenHeader,
  SearchInput,
  SectionCard,
  SettingRow,
  SettingsList,
  StatsBar,
  StatusPill,
  Toolbar,
} from "@/components/internal/shared/screen_kit";
import { MainScreenWrapper, SecondaryScreenWrapper } from "@/components/internal/shared/screen_wrappers";
import { ListPagination, usePagination } from "@/components/internal/shared/pagination";
import { EditorHeader } from "@/components/internal/shared/editor_shell";
import FilterDropdown from "@/components/internal/screens/overview/filter_dropdown";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { useRecordParam } from "@/lib/hooks/use-record-param";

const PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";
const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";
const DANGER = "bg-red-500/90 text-white hover:bg-red-500";

const KEY_STATUS_MAP = {
  enabled: { label: "Enabled", variant: "success", dotClass: "bg-emerald-400" },
  disabled: { label: "Disabled", variant: "neutral", dotClass: "bg-[#737373]" },
};

const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "All Statuses" },
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled" },
];

const CSV_TEMPLATE = "Name,Key,Description,Enabled,UsagePlanIds\n";

const EMPTY_DRAFT = { name: "", value: "", description: "", customerId: "" };

async function api(projectId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/api-keys${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error?.message ?? `Request failed (${response.status}).`);
    error.details = data?.error?.details;
    throw error;
  }
  return data;
}

const keyStatus = (key) => (key.enabled ? "enabled" : "disabled");

const formatDate = (value) => (value
  ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
  : "—");

function copyText(value, message = "Copied.") {
  navigator.clipboard?.writeText(value).then(
    () => toast.success(message),
    () => toast.error("Couldn't copy to the clipboard."),
  );
}

// Show-once (create/rotate) and reveal dialog: the value in a read-only mono
// field with a copy button.
function KeyValueDialog({ shown, onClose }) {
  return <Dialog open={!!shown} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-w-xl bg-background">
      <DialogHeader>
        <DialogTitle>{shown?.title}</DialogTitle>
        <DialogDescription>{shown?.description}</DialogDescription>
      </DialogHeader>
      <Field label="Key value" htmlFor="api-key-value">
        <div className="flex items-center gap-2">
          <Input
            id="api-key-value"
            readOnly
            value={shown?.value ?? ""}
            spellCheck={false}
            className="font-mono text-xs"
            onFocus={(event) => event.target.select()}
          />
          <Button variant="outline" className={SECONDARY} onClick={() => copyText(shown?.value ?? "", "Key value copied.")}>
            <Copy className="h-4 w-4" />Copy
          </Button>
        </div>
      </Field>
      {shown?.once ? <p className="flex items-start gap-2 text-xs text-amber-400">
        <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
        Copy this value now. It&apos;s shown once and never stored in readable form.
      </p> : null}
      <DialogFooter>
        <Button className={PRIMARY} onClick={onClose}>Done</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function CreateKeyDialog({ open, onOpenChange, busy, onCreate }) {
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const set = (field) => (event) => setDraft((current) => ({ ...current, [field]: event.target.value }));

  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setDraft(EMPTY_DRAFT);
  }

  const submit = () => {
    if (!draft.name.trim()) {
      toast.error("Give your key a name first.");
      return;
    }
    onCreate(draft);
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-xl bg-background">
      <DialogHeader>
        <DialogTitle>Create API Key</DialogTitle>
        <DialogDescription>Leave the value empty to generate 40 random characters. You&apos;ll see the value once, right after it&apos;s created.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <Field label="Name" htmlFor="key-name">
          <Input
            id="key-name"
            value={draft.name}
            onChange={set("name")}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submit(); } }}
            placeholder="e.g. Acme mobile app"
            maxLength={128}
            autoFocus
          />
        </Field>
        <Field label="Custom value (optional)" htmlFor="key-value" hint="20–128 characters of letters, digits, dash or underscore.">
          <Input id="key-value" className="font-mono text-xs" value={draft.value} onChange={set("value")} placeholder="Leave empty to generate" spellCheck={false} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Description" htmlFor="key-desc">
            <Input id="key-desc" value={draft.description} onChange={set("description")} />
          </Field>
          <Field label="Customer ID" htmlFor="key-customer">
            <Input id="key-customer" value={draft.customerId} onChange={set("customerId")} />
          </Field>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" className={SECONDARY} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button className={PRIMARY} disabled={busy} onClick={submit}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Create API Key
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function ImportKeysDialog({ open, onOpenChange, busy, onImport }) {
  const [csv, setCsv] = useState(CSV_TEMPLATE);
  const [warnings, setWarnings] = useState([]);

  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setWarnings([]);
  }

  const run = async (failOnWarnings) => {
    const result = await onImport(csv, failOnWarnings);
    setWarnings(result?.warnings ?? []);
    if (result?.ok && (result.warnings ?? []).length === 0) onOpenChange(false);
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-xl bg-background">
      <DialogHeader>
        <DialogTitle>Import API Keys</DialogTitle>
        <DialogDescription>Paste an AWS-format key file. Rows with problems become warnings and are skipped, unless you choose to fail on warnings.</DialogDescription>
      </DialogHeader>
      <Field label="CSV" htmlFor="key-csv" hint="Header: Name,Key,Description,Enabled,UsagePlanIds">
        <Textarea id="key-csv" className="min-h-40 font-mono text-xs" value={csv} onChange={(event) => setCsv(event.target.value)} spellCheck={false} />
      </Field>
      {warnings.length > 0 ? <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
        <p className="text-sm font-medium text-amber-400">{warnings.length} warning{warnings.length === 1 ? "" : "s"}</p>
        <ul className="mt-1.5 max-h-40 space-y-1 overflow-y-auto text-xs text-text-secondary">
          {warnings.map((warning, index) => <li key={index}>{warning}</li>)}
        </ul>
      </div> : null}
      <DialogFooter>
        <Button variant="outline" className={SECONDARY} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="outline" className={SECONDARY} disabled={busy} onClick={() => run(true)}>Import (Fail on Warnings)</Button>
        <Button className={PRIMARY} disabled={busy} onClick={() => run(false)}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}Import
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

// Delete and disable both cut callers off, so both confirm first.
function ConfirmKeyDialog({ confirm, busy, onCancel, onConfirm }) {
  const disabling = confirm?.kind === "disable";
  return <Dialog open={!!confirm} onOpenChange={(open) => { if (!open) onCancel(); }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{disabling ? "Disable API key" : "Delete API key"}</DialogTitle>
        <DialogDescription>
          {disabling ? "Disable " : "Are you sure you want to delete "}
          <span className="font-medium text-foreground">{confirm?.key?.name}</span>
          {disabling
            ? "? Callers using it are rejected within a minute. You can enable it again later."
            : "? Callers using it are rejected and it leaves every usage plan. This action can't be undone."}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button className={DANGER} disabled={busy} onClick={onConfirm}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : disabling ? <PowerOff className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
          {disabling ? "Disable" : "Delete"}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function ApiKeysScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [recordId, setRecordId] = useRecordParam();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [shown, setShown] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  // Bumped after any mutation so an open edit page refetches its key.
  const [revision, setRevision] = useState(0);
  const writable = can("pods.api_key.write");
  const revealable = can("pods.api_key.reveal");

  const refresh = useCallback(async () => {
    setRevision((value) => value + 1);
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

  const keys = state.items;

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return keys.filter((key) => {
      if (status !== "all" && keyStatus(key) !== status) return false;
      return !query || `${key.name} ${key.description ?? ""} ${key.prefix ?? ""} ${key.customerId ?? ""} ${key.publicId ?? ""}`
        .toLowerCase().includes(query);
    });
  }, [keys, search, status]);

  const pager = usePagination(filtered, { resetKey: `${search}|${status}` });

  const stats = useMemo(() => {
    const enabled = keys.filter((key) => key.enabled).length;
    return [
      { label: "Total keys", value: String(keys.length), footer: "Across this project" },
      { label: "Enabled", value: String(enabled), footer: "Accepted at the gateway" },
      { label: "Disabled", value: String(keys.length - enabled), footer: "Rejected at the gateway" },
      { label: "Never used", value: String(keys.filter((key) => !key.lastUsedAt).length), footer: "No calls recorded yet" },
    ];
  }, [keys]);

  const create = async (draft) => {
    setBusy(true);
    try {
      const created = await api(project.id, "", {
        method: "POST",
        body: JSON.stringify({
          name: draft.name.trim(),
          ...(draft.value ? { value: draft.value } : {}),
          ...(draft.description ? { description: draft.description } : {}),
          ...(draft.customerId ? { customerId: draft.customerId } : {}),
        }),
      });
      setCreating(false);
      setShown({
        title: "Copy Your API Key",
        description: `"${created.name}" is ready. Attach it to a usage plan to let it call an API stage.`,
        value: created.value,
        once: true,
      });
      toast.success(`"${created.name}" created.`);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const reveal = async (key) => {
    setBusy(true);
    try {
      const data = await api(project.id, `/${encodeURIComponent(key.id)}?includeValue=true`);
      setShown({
        title: "API Key Value",
        description: `The value of "${data.name}". Reveals are recorded in the audit log.`,
        value: data.value,
        once: false,
      });
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = async (key, enabled) => {
    setBusy(true);
    try {
      await api(project.id, `/${encodeURIComponent(key.id)}`, {
        method: "PATCH",
        headers: { "If-Match": String(key.version) },
        body: JSON.stringify({ enabled }),
      });
      toast.success(enabled ? `Enabled "${key.name}".` : `Disabled "${key.name}". The gateway blocks it within a minute.`);
      setConfirm(null);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const rotate = async (key) => {
    setBusy(true);
    try {
      const rotated = await api(project.id, `/${encodeURIComponent(key.id)}/rotate`, { method: "POST", body: "{}" });
      setShown({
        title: "Copy Your New API Key",
        description: `"${rotated.name}" joins the same usage plans. The old key stays enabled until you disable it.`,
        value: rotated.value,
        once: true,
      });
      toast.success(`Rotated "${key.name}".`);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (key) => {
    setBusy(true);
    try {
      await api(project.id, `/${encodeURIComponent(key.id)}`, { method: "DELETE" });
      toast.success(`Deleted "${key.name}".`);
      setConfirm(null);
      if (recordId) setRecordId(null);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const importCsv = async (csv, failOnWarnings) => {
    setBusy(true);
    try {
      const result = await api(project.id, "/import", {
        method: "POST",
        body: JSON.stringify({ csv, failOnWarnings }),
      });
      const warnings = result.warnings ?? [];
      toast.success(`Imported ${result.ids.length} key${result.ids.length === 1 ? "" : "s"}.`);
      if (warnings.length > 0) toast.warning(`${warnings.length} warning${warnings.length === 1 ? "" : "s"} — see the import dialog.`);
      await refresh();
      return { ok: true, warnings };
    } catch (error) {
      toast.error(error.message);
      return { ok: false, warnings: error.details?.warnings ?? [] };
    } finally {
      setBusy(false);
    }
  };

  const confirmAction = () => {
    if (!confirm) return;
    if (confirm.kind === "disable") setEnabled(confirm.key, false);
    else remove(confirm.key);
  };

  const keyActions = {
    reveal: revealable ? reveal : null,
    rotate: writable ? rotate : null,
    enable: writable ? (key) => setEnabled(key, true) : null,
    disable: writable ? (key) => setConfirm({ kind: "disable", key }) : null,
    remove: writable ? (key) => setConfirm({ kind: "delete", key }) : null,
  };

  const dialogs = <>
    {writable ? <CreateKeyDialog open={creating} onOpenChange={setCreating} busy={busy} onCreate={create} /> : null}
    {writable ? <ImportKeysDialog open={importing} onOpenChange={setImporting} busy={busy} onImport={importCsv} /> : null}
    <KeyValueDialog shown={shown} onClose={() => setShown(null)} />
    <ConfirmKeyDialog confirm={confirm} busy={busy} onCancel={() => setConfirm(null)} onConfirm={confirmAction} />
  </>;

  if (recordId) {
    return <>
      <KeyEditPage
        key={recordId}
        keyId={recordId}
        revision={revision}
        writable={writable}
        busy={busy}
        actions={keyActions}
        onBack={() => setRecordId(null)}
        onSaved={refresh}
      />
      {dialogs}
    </>;
  }

  const columns = [
    {
      key: "name",
      header: "Key",
      render: (key) => <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-card text-muted-foreground">
          <KeyRound className="h-4 w-4" />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate font-medium text-foreground">{key.name}</span>
          <span className="block max-w-[26rem] truncate text-xs text-text-secondary">{key.description || "No description"}</span>
        </div>
      </div>,
    },
    { key: "prefix", header: "Value", render: (key) => <span className="font-mono text-xs text-text-secondary">…{key.prefix}</span> },
    { key: "customer", header: "Customer", render: (key) => <span className="text-sm text-text-secondary">{key.customerId || "—"}</span> },
    { key: "status", header: "Status", render: (key) => <StatusPill status={keyStatus(key)} map={KEY_STATUS_MAP} /> },
    {
      key: "lastUsed",
      header: "Last used",
      render: (key) => <span className="text-sm tabular-nums text-text-secondary">{key.lastUsedAt ? formatDate(key.lastUsedAt) : "Never"}</span>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (key) => <ActionMenu
        label={`Actions for ${key.name}`}
        items={[
          { icon: Pencil, label: writable ? "Edit" : "Open", onSelect: () => setRecordId(key.id) },
          revealable && { icon: Eye, label: "Reveal value", disabled: busy, onSelect: () => reveal(key) },
          { icon: Copy, label: "Copy key ID", onSelect: () => copyText(key.publicId ?? key.id) },
          writable && { icon: RotateCw, label: "Rotate", disabled: busy, onSelect: () => rotate(key) },
          writable && (key.enabled
            ? { icon: PowerOff, label: "Disable", onSelect: () => setConfirm({ kind: "disable", key }) }
            : { icon: Power, label: "Enable", disabled: busy, onSelect: () => setEnabled(key, true) }),
          writable && { separator: true },
          writable && { icon: Trash2, label: "Delete", variant: "destructive", onSelect: () => setConfirm({ kind: "delete", key }) },
        ]}
      />,
    },
  ];

  const createButton = writable
    ? <Button className={PRIMARY} onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New API Key</Button>
    : null;

  return <MainScreenWrapper>
    <ScreenHeader
      title="API Keys"
      description="Keys identify the callers of your usage plans. They don't authenticate anyone — pair them with an authorizer for that."
      actions={writable ? <div className="flex flex-wrap gap-2">
        <Button variant="outline" className={SECONDARY} onClick={() => setImporting(true)}><Upload className="h-4 w-4" /> Import CSV</Button>
        {createButton}
      </div> : null}
    />

    <StatsBar stats={stats} />

    <Toolbar>
      <div className="flex flex-wrap items-center gap-2">
        <FilterDropdown label="Status" value={status} onValueChange={setStatus} options={STATUS_FILTER_OPTIONS} height="h-9" />
      </div>
      <SearchInput value={search} onChange={setSearch} placeholder="Search keys, customers, prefixes…" />
    </Toolbar>

    {state.status === "loading" ? <LoadingArea panel label="Loading API keys" /> : null}
    {state.status === "error" ? <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={KeyRound}
      title="API keys unavailable"
      description={state.error}
      action={<Button variant="outline" onClick={() => { setState({ status: "loading", items: [], error: null }); refresh(); }}>Retry</Button>}
    /></div> : null}
    {state.status === "ready" ? <div className="space-y-5">
      <DataTable
        columns={columns}
        data={pager.pageItems}
        getRowKey={(key) => key.id}
        onRowClick={(key) => setRecordId(key.id)}
        empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
          icon={KeyRound}
          title={keys.length ? "No API keys match your filters" : "No API keys yet"}
          description={keys.length
            ? "Try clearing the search or status filter."
            : "Create a key, then attach it to a usage plan to let it call an API stage."}
          action={keys.length ? null : createButton}
        /></div>}
      />
      <ListPagination {...pager} itemLabel="API keys" />
    </div> : null}

    {dialogs}
  </MainScreenWrapper>;
}

function KeyEditPage({ keyId, revision, writable, busy, actions, onBack, onSaved }) {
  const { project } = useProject();
  const [state, setState] = useState({ status: "loading", key: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const back = { label: "All API Keys", onClick: onBack };

  useEffect(() => {
    let alive = true;
    api(project.id, `/${encodeURIComponent(keyId)}`).then(
      (key) => { if (alive) setState({ status: "ready", key, error: null }); },
      (error) => { if (alive) setState({ status: "error", key: null, error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id, keyId, revision, attempt]);

  if (state.status === "loading") return <LoadingArea label="Loading API key" />;
  if (state.status === "error") {
    return <SecondaryScreenWrapper>
      <EditorHeader back={back} title="API key unavailable" />
      <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
        icon={KeyRound}
        title="API key unavailable"
        description={state.error}
        action={<Button variant="outline" onClick={() => { setState({ status: "loading", key: null, error: null }); setAttempt((value) => value + 1); }}>Retry</Button>}
      /></div>
    </SecondaryScreenWrapper>;
  }
  return <KeyEditForm apiKey={state.key} back={back} writable={writable} busy={busy} actions={actions} onSaved={onSaved} />;
}

function KeyEditForm({ apiKey, back, writable, busy, actions, onSaved }) {
  const { project } = useProject();
  const [form, setForm] = useState({
    name: apiKey.name ?? "",
    description: apiKey.description ?? "",
    customerId: apiKey.customerId ?? "",
  });
  const [saving, setSaving] = useState(false);
  const set = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));

  const save = async () => {
    if (!form.name.trim()) {
      toast.error("Give your key a name first.");
      return;
    }
    setSaving(true);
    try {
      await api(project.id, `/${encodeURIComponent(apiKey.id)}`, {
        method: "PATCH",
        headers: { "If-Match": String(apiKey.version) },
        body: JSON.stringify({
          name: form.name.trim(),
          description: form.description,
          customerId: form.customerId.trim() || null,
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

  const plans = apiKey.plans ?? [];

  return <SecondaryScreenWrapper>
    <EditorHeader
      back={back}
      title={apiKey.name}
      status={keyStatus(apiKey)}
      statusMap={KEY_STATUS_MAP}
      badges={<span className="font-mono text-xs text-text-secondary">{apiKey.publicId}</span>}
      meta={apiKey.description || undefined}
      actions={actions.reveal || actions.rotate || writable ? <>
        {actions.reveal ? <Button variant="outline" className={SECONDARY} disabled={busy} onClick={() => actions.reveal(apiKey)}>
          <Eye className="h-4 w-4" />Reveal Value
        </Button> : null}
        {actions.rotate ? <Button variant="outline" className={SECONDARY} disabled={busy} onClick={() => actions.rotate(apiKey)}>
          <RotateCw className="h-4 w-4" />Rotate
        </Button> : null}
        {writable ? <Button className={PRIMARY} disabled={saving} onClick={save}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {saving ? "Saving…" : "Save Changes"}
        </Button> : null}
      </> : null}
    />

    <SectionCard title="Details" description="How this key appears in lists, usage reports and the audit log.">
      <div className="grid gap-4">
        <Field label="Name" htmlFor="key-edit-name">
          <Input id="key-edit-name" value={form.name} onChange={set("name")} readOnly={!writable} maxLength={128} />
        </Field>
        <Field label="Description" htmlFor="key-edit-description">
          <Textarea id="key-edit-description" value={form.description} onChange={set("description")} readOnly={!writable} rows={2} maxLength={1024} />
        </Field>
        <Field label="Customer ID" htmlFor="key-edit-customer" hint="Optional. Your own identifier for whoever holds this key.">
          <Input id="key-edit-customer" value={form.customerId} onChange={set("customerId")} readOnly={!writable} maxLength={256} />
        </Field>
      </div>
    </SectionCard>

    <SectionCard title="Key" description="Identifiers only. The value itself is never shown here.">
      <dl className="grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-text-secondary">Key ID</dt>
          <dd className="flex items-center gap-1 text-sm text-foreground">
            <span className="truncate font-mono text-xs">{apiKey.publicId}</span>
            <Button variant="ghost" size="icon-sm" aria-label="Copy key ID" onClick={() => copyText(apiKey.publicId ?? apiKey.id)}>
              <Copy className="h-4 w-4" />
            </Button>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-text-secondary">Value</dt>
          <dd className="font-mono text-xs leading-8 text-foreground">…{apiKey.prefix}</dd>
        </div>
        <div>
          <dt className="text-xs text-text-secondary">Created</dt>
          <dd className="text-sm text-foreground">{formatDate(apiKey.createdAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-text-secondary">Last used</dt>
          <dd className="text-sm text-foreground">{apiKey.lastUsedAt ? formatDate(apiKey.lastUsedAt) : "Never"}</dd>
        </div>
      </dl>
    </SectionCard>

    <SectionCard title="Status">
      <SettingsList>
        <SettingRow
          icon={Power}
          title="Enabled"
          description="Disabled keys are rejected at the gateway within a minute."
          {...(writable
            ? {
              checked: apiKey.enabled,
              onCheckedChange: (next) => (next ? actions.enable(apiKey) : actions.disable(apiKey)),
            }
            : { control: <StatusPill status={keyStatus(apiKey)} map={KEY_STATUS_MAP} /> })}
        />
      </SettingsList>
    </SectionCard>

    <SectionCard title="Usage Plans" description="Plans this key belongs to. Add or remove it from a plan's API Keys section.">
      {plans.length === 0
        ? <p className="text-sm text-text-secondary">This key isn&apos;t in any usage plan yet.</p>
        : <div className="flex flex-wrap gap-2">
          {plans.map((plan) => <Badge key={plan.id} variant="neutral">{plan.name}</Badge>)}
        </div>}
    </SectionCard>

    {actions.remove ? <div className="rounded-xl border border-red-500/30 p-4">
      <p className="text-sm font-semibold text-red-400">Danger zone</p>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-4 border-t border-red-500/20 pt-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Delete this API key</p>
          <p className="text-xs text-text-secondary">Callers using it are rejected and it leaves every usage plan. This can&apos;t be undone.</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="border-red-500/40 bg-transparent text-red-400 hover:bg-red-500/10 hover:text-red-400"
          onClick={() => actions.remove(apiKey)}
        ><Trash2 className="h-4 w-4" />Delete API Key</Button>
      </div>
    </div> : null}
  </SecondaryScreenWrapper>;
}
