"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, History, KeyRound, Loader2, LockKeyhole, Plus, RotateCw, Trash2 } from "lucide-react";
import {
  DataTable, EmptyState, Field, LoadingArea, ScreenHeader, SearchInput, SectionCard, StatsBar, StatusPill, Toolbar,
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { useRecordParam } from "@/lib/hooks/use-record-param";

const SECRET_KINDS = [
  { value: "generic", label: "Generic" },
  { value: "header", label: "Header" },
  { value: "basic_auth", label: "Basic auth" },
  { value: "bearer", label: "Bearer token" },
  { value: "aws_credentials", label: "AWS credentials" },
  { value: "client_certificate", label: "Client certificate" },
  { value: "private_key", label: "Private key" },
  { value: "oauth_client", label: "OAuth client" },
];

const KIND_LABEL = Object.fromEntries(SECRET_KINDS.map((entry) => [entry.value, entry.label]));
const kindLabel = (kind) => KIND_LABEL[kind] ?? kind;

const KIND_FILTER_OPTIONS = [{ value: "all", label: "All Kinds" }, ...SECRET_KINDS];

// One control per value field; values are write-only and never rendered back.
const KIND_FIELDS = {
  generic: [{ key: "value", label: "Value", multiline: true }],
  header: [{ key: "name", label: "Header name" }, { key: "value", label: "Header value", multiline: true }],
  basic_auth: [{ key: "username", label: "Username" }, { key: "password", label: "Password", secret: true }],
  bearer: [{ key: "token", label: "Token", secret: true }],
  aws_credentials: [
    { key: "accessKeyId", label: "Access key ID" },
    { key: "secretAccessKey", label: "Secret access key", secret: true },
    { key: "sessionToken", label: "Session token (optional)", secret: true, optional: true },
    { key: "region", label: "Region (optional)", optional: true },
  ],
  client_certificate: [
    { key: "certificatePem", label: "Certificate PEM", multiline: true },
    { key: "privateKeyPem", label: "Private key PEM", multiline: true, secret: true },
    { key: "passphrase", label: "Passphrase (optional)", secret: true, optional: true },
  ],
  private_key: [
    { key: "pem", label: "Private key PEM", multiline: true, secret: true },
    { key: "passphrase", label: "Passphrase (optional)", secret: true, optional: true },
  ],
  oauth_client: [
    { key: "tokenUrl", label: "Token URL" },
    { key: "clientId", label: "Client ID" },
    { key: "clientSecret", label: "Client secret", secret: true },
    { key: "scope", label: "Scope (optional)", optional: true },
    { key: "audience", label: "Audience (optional)", optional: true },
  ],
};

const VERSION_STATUS_MAP = {
  current: { label: "Current", variant: "success", dotClass: "bg-emerald-400" },
  enabled: { label: "Enabled", variant: "info", dotClass: "bg-sky-400" },
  disabled: { label: "Disabled", variant: "neutral", dotClass: "bg-[#737373]" },
};

const CANCEL_CLASS = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";
const PRIMARY_CLASS = "bg-primary text-primary-foreground hover:bg-primary/90";

const formatDate = (value) => (value ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");

async function api(projectId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/secrets${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

function useSecrets(projectId) {
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const refresh = useCallback(async () => {
    try {
      const data = await api(projectId, "");
      setState({ status: "ready", items: data.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [projectId]);
  const retry = useCallback(() => {
    setState({ status: "loading", items: [], error: null });
    return refresh();
  }, [refresh]);
  useEffect(() => {
    let alive = true;
    api(projectId, "").then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [projectId]);
  return { ...state, refresh, retry };
}

// The value object a kind's fields produce: trimmed, empty entries dropped.
function collectValue(kind, fields) {
  const value = {};
  for (const field of KIND_FIELDS[kind] ?? []) {
    const entry = (fields[field.key] ?? "").trim();
    if (entry) value[field.key] = entry;
  }
  return value;
}

function ValueFields({ kind, fields, setFields }) {
  return (KIND_FIELDS[kind] ?? []).map((field) => {
    const id = `secret-${field.key}`;
    const onChange = (event) => setFields((current) => ({ ...current, [field.key]: event.target.value }));
    return <Field key={field.key} label={`${field.label}${field.optional ? "" : " *"}`} htmlFor={id}>
      {field.multiline
        ? <Textarea id={id} value={fields[field.key] ?? ""} onChange={onChange} rows={3} autoComplete="off" spellCheck={false} className="font-mono text-xs" />
        : <Input id={id} type={field.secret ? "password" : "text"} value={fields[field.key] ?? ""} onChange={onChange} autoComplete="off" spellCheck={false} />}
    </Field>;
  });
}

function CreateSecretDialog({ projectId, open, onOpenChange, onCreated }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("bearer");
  const [description, setDescription] = useState("");
  const [fields, setFields] = useState({});
  const [saving, setSaving] = useState(false);

  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setName("");
      setKind("bearer");
      setDescription("");
      setFields({});
    }
  }

  const submit = async (event) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Give the secret a name first.");
      return;
    }
    setSaving(true);
    try {
      await api(projectId, "", {
        method: "POST",
        body: JSON.stringify({ name: trimmed, kind, description: description.trim() || undefined, value: collectValue(kind, fields) }),
      });
      toast.success(`"${trimmed}" created.`);
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
        <DialogTitle>New Secret</DialogTitle>
        <DialogDescription>Values are write-only: they&apos;re encrypted on save and never shown again.</DialogDescription>
      </DialogHeader>
      <form className="grid gap-4" onSubmit={submit}>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name" htmlFor="secret-name">
            <Input id="secret-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="upstream-api-key" autoFocus />
          </Field>
          <Field label="Kind" htmlFor="secret-kind">
            <Select value={kind} onValueChange={(next) => { setKind(next); setFields({}); }}>
              <SelectTrigger id="secret-kind" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{SECRET_KINDS.map((entry) => <SelectItem key={entry.value} value={entry.value}>{entry.label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        </div>
        <Field label="Description (optional)" htmlFor="secret-description">
          <Input id="secret-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this credential is for" />
        </Field>
        <ValueFields kind={kind} fields={fields} setFields={setFields} />
        <DialogFooter>
          <Button type="button" variant="outline" className={CANCEL_CLASS} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" className={PRIMARY_CLASS} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Create Secret
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

function RotateSecretDialog({ projectId, secret, onOpenChange, onRotated }) {
  const [fields, setFields] = useState({});
  const [saving, setSaving] = useState(false);

  const [prevId, setPrevId] = useState(secret?.id ?? null);
  if ((secret?.id ?? null) !== prevId) {
    setPrevId(secret?.id ?? null);
    setFields({});
  }

  const submit = async (event) => {
    event.preventDefault();
    if (!secret) return;
    setSaving(true);
    try {
      await api(projectId, `/${encodeURIComponent(secret.id)}/rotate`, {
        method: "POST",
        body: JSON.stringify({ value: collectValue(secret.kind, fields) }),
      });
      toast.success(`Rotated ${secret.name} to v${secret.currentVersion + 1}.`);
      onOpenChange(false);
      await onRotated();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  return <Dialog open={!!secret} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-xl bg-background">
      <DialogHeader>
        <DialogTitle>Rotate Secret</DialogTitle>
        <DialogDescription>
          Store a new value for <span className="font-medium text-foreground">{secret?.name}</span> ({kindLabel(secret?.kind)}).
          The previous version stays valid until you disable it.
        </DialogDescription>
      </DialogHeader>
      <form className="grid gap-4" onSubmit={submit}>
        {secret ? <ValueFields kind={secret.kind} fields={fields} setFields={setFields} /> : null}
        <DialogFooter>
          <Button type="button" variant="outline" className={CANCEL_CLASS} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" className={PRIMARY_CLASS} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Save New Version
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

function DeleteSecretDialog({ projectId, secret, onOpenChange, onDeleted }) {
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await api(projectId, `/${encodeURIComponent(secret.id)}`, { method: "DELETE" });
      toast.success(`Deleted "${secret.name}".`);
      onOpenChange(false);
      await onDeleted();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };
  return <Dialog open={!!secret} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Delete secret</DialogTitle>
        <DialogDescription>
          Are you sure you want to delete <span className="font-medium text-foreground">{secret?.name}</span>? Every version is
          destroyed. This action can&apos;t be undone.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button className="bg-red-500/90 text-white hover:bg-red-500" disabled={busy} onClick={remove}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Delete
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

// A secret still referenced by integrations/authorizers must be detached first;
// the server refuses too, but this says why before the confirm dialog opens.
function guardDelete(secret, open) {
  if ((secret.usedBy ?? 0) > 0) {
    toast.error(`Secret "${secret.name}" is still referenced by ${secret.usedBy} configuration row(s); detach it first.`);
    return;
  }
  open(secret);
}

function versionStatus(entry, secret) {
  if (entry.version === secret.currentVersion) return "current";
  return entry.disabledAt ? "disabled" : "enabled";
}

function SecretRecordPage({ projectId, secretId, onBack, onChanged }) {
  const [state, setState] = useState({ status: "loading", secret: null, error: null });
  const [rotating, setRotating] = useState(null);
  const [disableTarget, setDisableTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const secret = await api(projectId, `/${encodeURIComponent(secretId)}`);
      setState({ status: "ready", secret, error: null });
    } catch (error) {
      setState({ status: "error", secret: null, error: error.message });
    }
  }, [projectId, secretId]);

  useEffect(() => {
    let alive = true;
    api(projectId, `/${encodeURIComponent(secretId)}`).then(
      (secret) => { if (alive) setState({ status: "ready", secret, error: null }); },
      (error) => { if (alive) setState({ status: "error", secret: null, error: error.message }); },
    );
    return () => { alive = false; };
  }, [projectId, secretId]);

  const back = { label: "All Secrets", onClick: onBack };

  if (state.status === "loading") return <LoadingArea label="Loading secret" />;
  if (state.status === "error") {
    return <SecondaryScreenWrapper>
      <EditorHeader back={back} title="Secret unavailable" />
      <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
        icon={KeyRound}
        title="Secret unavailable"
        description={state.error}
        action={<Button variant="outline" onClick={() => { setState({ status: "loading", secret: null, error: null }); load(); }}>Retry</Button>}
      /></div>
    </SecondaryScreenWrapper>;
  }

  const secret = state.secret;
  const versions = [...(secret.versions ?? [])].sort((a, b) => b.version - a.version);

  const disableVersion = async () => {
    const version = disableTarget;
    setBusy(true);
    try {
      await api(projectId, `/${encodeURIComponent(secret.id)}/versions/${encodeURIComponent(String(version))}/disable`, { method: "POST" });
      toast.success(`Disabled ${secret.name} v${version}.`);
      setDisableTarget(null);
      await Promise.all([load(), onChanged()]);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const facts = [
    { label: "Kind", value: kindLabel(secret.kind) },
    { label: "Fingerprint", value: <span className="font-mono text-xs">ending {secret.fingerprint}</span> },
    { label: "Current version", value: `v${secret.currentVersion}` },
    { label: "Last rotated", value: secret.lastRotatedAt ? formatDate(secret.lastRotatedAt) : "Never" },
    { label: "Expires", value: secret.expiresAt ? formatDate(secret.expiresAt) : "Never" },
    { label: "Used by", value: secret.usedBy > 0 ? `${secret.usedBy} configuration row${secret.usedBy === 1 ? "" : "s"}` : "Not referenced" },
  ];

  const versionColumns = [
    {
      key: "version",
      header: "Version",
      render: (entry) => <span className="font-medium tabular-nums text-foreground">v{entry.version}</span>,
    },
    { key: "status", header: "Status", render: (entry) => <StatusPill status={versionStatus(entry, secret)} map={VERSION_STATUS_MAP} /> },
    { key: "created", header: "Created", render: (entry) => <span className="text-sm tabular-nums text-text-secondary">{formatDate(entry.createdAt)}</span> },
    { key: "disabled", header: "Disabled", render: (entry) => <span className="text-sm tabular-nums text-text-secondary">{formatDate(entry.disabledAt)}</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (entry) => <ActionMenu
        label={`Actions for v${entry.version}`}
        items={[
          !entry.disabledAt && entry.version !== secret.currentVersion
            && { icon: Ban, label: "Disable", destructive: true, onSelect: () => setDisableTarget(entry.version) },
        ]}
      />,
    },
  ];

  return <SecondaryScreenWrapper>
    <EditorHeader
      back={back}
      title={secret.name}
      badges={<>
        <Badge variant="neutral">{kindLabel(secret.kind)}</Badge>
        <span className="font-mono text-xs text-text-secondary">ending {secret.fingerprint}</span>
      </>}
      meta={secret.description || undefined}
      actions={<Button className={PRIMARY_CLASS} onClick={() => setRotating(secret)}><RotateCw className="h-4 w-4" /> Rotate</Button>}
    />

    <div className="mt-6 space-y-6">
      <SectionCard title="Details">
        <dl className="grid gap-4 sm:grid-cols-2">
          {facts.map((fact) => <div key={fact.label}>
            <dt className="text-xs text-text-secondary">{fact.label}</dt>
            <dd className="mt-1 text-sm text-foreground">{fact.value}</dd>
          </div>)}
        </dl>
      </SectionCard>

      <SectionCard
        title="Versions"
        description="Disable an old version to stop resolving it. The current version can't be disabled; rotate first."
        bodyPadding={false}
      >
        <DataTable
          className="rounded-none border-0"
          columns={versionColumns}
          data={versions}
          getRowKey={(entry) => entry.version}
          empty={<EmptyState icon={History} title="No versions found" description="Rotate the secret to store a value." />}
        />
      </SectionCard>

      <SectionCard title="Danger zone">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Delete this secret</p>
            <p className="mt-0.5 text-xs text-text-secondary">
              {secret.usedBy > 0
                ? `Still referenced by ${secret.usedBy} configuration row(s); detach it first.`
                : "Destroys every version. Integrations can no longer resolve it."}
            </p>
          </div>
          <Button
            variant="outline"
            className="border-red-500/30 text-red-600 hover:bg-red-500/10 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
            onClick={() => guardDelete(secret, setDeleteTarget)}
          ><Trash2 className="h-4 w-4" /> Delete</Button>
        </div>
      </SectionCard>
    </div>

    <RotateSecretDialog
      projectId={projectId}
      secret={rotating}
      onOpenChange={(open) => { if (!open) setRotating(null); }}
      onRotated={() => Promise.all([load(), onChanged()])}
    />
    <Dialog open={disableTarget !== null} onOpenChange={(open) => { if (!open) setDisableTarget(null); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Disable version</DialogTitle>
          <DialogDescription>
            Disable <span className="font-medium text-foreground">{secret.name} v{disableTarget}</span>? Anything still resolving this
            version stops working. This action can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setDisableTarget(null)}>Cancel</Button>
          <Button className="bg-red-500/90 text-white hover:bg-red-500" disabled={busy} onClick={disableVersion}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />} Disable
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <DeleteSecretDialog
      projectId={projectId}
      secret={deleteTarget}
      onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      onDeleted={async () => { onBack(); await onChanged(); }}
    />
  </SecondaryScreenWrapper>;
}

export function SecretsScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const { status, items, error, refresh, retry } = useSecrets(project.id);
  const [recordId, setRecordId] = useRecordParam();
  const [creating, setCreating] = useState(false);
  const [rotating, setRotating] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("all");
  const writable = can("pods.secret.write");

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items.filter((secret) => {
      if (kind !== "all" && secret.kind !== kind) return false;
      return !query || `${secret.name} ${secret.description ?? ""} ${secret.fingerprint ?? ""}`.toLowerCase().includes(query);
    });
  }, [items, search, kind]);

  const pager = usePagination(filtered, { resetKey: `${search}|${kind}` });

  const stats = useMemo(() => {
    const inUse = items.filter((secret) => (secret.usedBy ?? 0) > 0).length;
    return [
      { label: "Secrets", value: String(items.length), footer: "Encrypted at rest" },
      { label: "In use", value: String(inUse), footer: "Referenced by config" },
      { label: "Unused", value: String(items.length - inUse), footer: "Safe to delete" },
      { label: "Never rotated", value: String(items.filter((secret) => !secret.lastRotatedAt).length), footer: "Still on first value" },
    ];
  }, [items]);

  if (!writable) {
    return <MainScreenWrapper>
      <ScreenHeader title="Secrets" description="Backend credentials for your integrations." />
      <div className="rounded-xl border border-border bg-surface-subtle">
        <EmptyState icon={LockKeyhole} title="Access unavailable" description="Your current team access does not allow this screen." />
      </div>
    </MainScreenWrapper>;
  }

  if (recordId) {
    return <SecretRecordPage
      key={recordId}
      projectId={project.id}
      secretId={recordId}
      onBack={() => setRecordId(null)}
      onChanged={refresh}
    />;
  }

  const openSecret = (secret) => setRecordId(secret.id);

  const columns = [
    {
      key: "name",
      header: "Secret",
      render: (secret) => <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-card text-muted-foreground">
          <KeyRound className="h-4 w-4" />
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-medium text-foreground">{secret.name}</span>
          <span className="block max-w-[26rem] truncate text-xs text-text-secondary">{secret.description || "No description"}</span>
        </div>
      </div>,
    },
    { key: "kind", header: "Kind", render: (secret) => <Badge variant="neutral">{kindLabel(secret.kind)}</Badge> },
    { key: "fingerprint", header: "Fingerprint", render: (secret) => <span className="font-mono text-xs text-text-secondary">ending {secret.fingerprint}</span> },
    { key: "version", header: "Version", align: "right", render: (secret) => <span className="text-sm tabular-nums text-text-secondary">v{secret.currentVersion}</span> },
    { key: "rotated", header: "Last rotated", render: (secret) => <span className="text-sm tabular-nums text-text-secondary">{secret.lastRotatedAt ? formatDate(secret.lastRotatedAt) : "Never"}</span> },
    { key: "usedBy", header: "Used by", align: "right", render: (secret) => <span className="text-sm tabular-nums text-text-secondary">{secret.usedBy ?? 0}</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (secret) => <ActionMenu
        label={`Actions for ${secret.name}`}
        items={[
          { icon: RotateCw, label: "Rotate", onSelect: () => setRotating(secret) },
          { icon: History, label: "Versions", onSelect: () => openSecret(secret) },
          { separator: true },
          { icon: Trash2, label: "Delete", destructive: true, onSelect: () => guardDelete(secret, setDeleteTarget) },
        ]}
      />,
    },
  ];

  const createButton = <Button className={PRIMARY_CLASS} onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New Secret</Button>;

  return <MainScreenWrapper>
    <ScreenHeader
      title="Secrets"
      description="Backend credentials, encrypted at rest. Values are write-only and referenced by integrations, never pasted into config."
      actions={createButton}
    />

    <StatsBar stats={stats} />

    <Toolbar>
      <div className="flex flex-wrap items-center gap-2">
        <FilterDropdown label="Kind" value={kind} onValueChange={setKind} options={KIND_FILTER_OPTIONS} height="h-9" />
      </div>
      <SearchInput value={search} onChange={setSearch} placeholder="Search secrets…" />
    </Toolbar>

    {status === "loading" ? <LoadingArea label="Loading secrets" /> : null}
    {status === "error" ? <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={KeyRound}
      title="Secrets unavailable"
      description={error}
      action={<Button variant="outline" onClick={retry}>Retry</Button>}
    /></div> : null}
    {status === "ready" ? <div className="space-y-5">
      <DataTable
        columns={columns}
        data={pager.pageItems}
        getRowKey={(secret) => secret.id}
        onRowClick={openSecret}
        empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
          icon={KeyRound}
          title={items.length ? "No secrets match your filters" : "No secrets yet"}
          description={items.length
            ? "Try clearing the search or kind filter."
            : "Store your first upstream credential. It is encrypted before it touches the database."}
          action={items.length ? null : createButton}
        /></div>}
      />
      <ListPagination {...pager} itemLabel="secrets" />
    </div> : null}

    <CreateSecretDialog projectId={project.id} open={creating} onOpenChange={setCreating} onCreated={refresh} />
    <RotateSecretDialog
      projectId={project.id}
      secret={rotating}
      onOpenChange={(open) => { if (!open) setRotating(null); }}
      onRotated={refresh}
    />
    <DeleteSecretDialog
      projectId={project.id}
      secret={deleteTarget}
      onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      onDeleted={refresh}
    />
  </MainScreenWrapper>;
}
