"use client";

// Connectors: outbound agents that reach private backends (VPC-link
// equivalent). The list shows health, agents online and last seen; the edit
// page (opened in place via ?record=) covers health, agent tokens (shown once
// on create/rotate, with the agent command), and the name and allow-list.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Cable, Copy, KeyRound, LayoutDashboard, Loader2, LockKeyhole, Pencil, Plus, RotateCw, Settings, Trash2 } from "lucide-react";
import {
  DataTable, EmptyState, Field, LoadingArea, ScreenHeader, SearchInput, SectionCard, StatsBar, StatusPill, Toolbar,
} from "@/components/internal/shared/screen_kit";
import { MainScreenWrapper } from "@/components/internal/shared/screen_wrappers";
import { ListPagination, usePagination } from "@/components/internal/shared/pagination";
import { EditorShell } from "@/components/internal/shared/editor_shell";
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

const CONNECTOR_STATUS_MAP = {
  AVAILABLE: { label: "Available", variant: "success", dotClass: "bg-emerald-400" },
  DEGRADED: { label: "Degraded", variant: "warning", dotClass: "bg-amber-400" },
  FAILED: { label: "Failed", variant: "danger", dotClass: "bg-red-400" },
  PENDING: { label: "Pending", variant: "neutral", dotClass: "bg-zinc-400" },
  DELETING: { label: "Deleting", variant: "neutral", dotClass: "bg-zinc-400" },
};

const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "All Statuses" },
  ...Object.entries(CONNECTOR_STATUS_MAP).map(([value, meta]) => ({ value, label: meta.label })),
];

const TOKEN_STATUS_MAP = {
  active: { label: "Active", variant: "success", dotClass: "bg-emerald-400" },
  revoked: { label: "Revoked", variant: "neutral", dotClass: "bg-zinc-400" },
};

async function api(projectId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/connectors${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

const formatDate = (value) => (value ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
const formatDateTime = (value) => (value ? new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Never");
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const parseTargets = (value) => String(value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);

async function copyText(value, label) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied.`);
  } catch {
    toast.error("Couldn't copy to the clipboard.");
  }
}

const cancelButtonClass = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";
const primaryButtonClass = "bg-primary text-primary-foreground hover:bg-primary/90";
const destructiveButtonClass = "bg-red-500/90 text-white hover:bg-red-500";

function ConfirmDialog({ open, onOpenChange, title, children, confirmLabel, icon: Icon = Trash2, busy, onConfirm }) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{children}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button className={destructiveButtonClass} disabled={busy} onClick={onConfirm}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}{confirmLabel}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

// Shown once after a token is created or rotated; the plaintext never comes back.
function TokenOnceDialog({ token, agentCommand, onClose }) {
  return <Dialog open={!!token} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-w-xl bg-background">
      <DialogHeader>
        <DialogTitle>Copy Your Agent Token</DialogTitle>
        <DialogDescription>Copy this token now — it is never shown again.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <Field label="Token" htmlFor="connector-token-once">
          <div className="flex items-center gap-2">
            <Input id="connector-token-once" readOnly value={token ?? ""} spellCheck={false} className="font-mono text-xs" onFocus={(event) => event.target.select()} />
            <Button variant="outline" onClick={() => copyText(token, "Token")}><Copy className="h-4 w-4" />Copy</Button>
          </div>
        </Field>
        <Field label="Run the agent inside your private network">
          <div className="relative">
            <pre className="overflow-x-auto rounded-lg border border-border bg-surface-card p-3 pr-12 font-mono text-xs text-foreground">{agentCommand}</pre>
            <Button variant="ghost" size="icon-sm" className="absolute right-2 top-2" aria-label="Copy agent command" onClick={() => copyText(agentCommand, "Command")}>
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
        </Field>
      </div>
      <DialogFooter>
        <Button className={primaryButtonClass} onClick={onClose}>Done</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

// --- Edit page ------------------------------------------------------------------

const CONNECTOR_NAV = [
  { key: "overview", label: "Overview", icon: LayoutDashboard, desc: "Health, connected agents and the backends they may reach." },
  { key: "tokens", label: "Agent Tokens", icon: KeyRound, desc: "Credentials your agents use to dial in. Rotate or revoke them here." },
  { key: "settings", label: "Settings", icon: Settings, desc: "Name, description, allowed targets and danger zone." },
];

function TokensSection({ projectId, connector }) {
  const [tokens, setTokens] = useState({ status: "loading", items: [] });
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState(null);
  const [confirm, setConfirm] = useState(null); // { action: "rotate" | "revoke", token }
  const [busy, setBusy] = useState(false);
  const base = `/${encodeURIComponent(connector.id)}/tokens`;

  const load = useCallback(() => api(projectId, base).then(
    (data) => setTokens({ status: "ready", items: data.items ?? [] }),
    () => setTokens({ status: "ready", items: [] }),
  ), [projectId, base]);

  useEffect(() => {
    let alive = true;
    api(projectId, base).then(
      (data) => { if (alive) setTokens({ status: "ready", items: data.items ?? [] }); },
      () => { if (alive) setTokens({ status: "ready", items: [] }); },
    );
    return () => { alive = false; };
  }, [projectId, base]);

  const create = async () => {
    setCreating(true);
    try {
      const result = await api(projectId, base, { method: "POST" });
      toast.success("Token created.");
      await load();
      if (result?.token) setFresh({ token: result.token, prefix: result.prefix });
    } catch (error) {
      toast.error(error.message);
    } finally {
      setCreating(false);
    }
  };

  const runConfirmed = async () => {
    const { action, token } = confirm;
    setBusy(true);
    try {
      if (action === "rotate") {
        const result = await api(projectId, `${base}/${encodeURIComponent(token.id)}`, {
          method: "POST",
          body: JSON.stringify({ action: "rotate" }),
        });
        toast.success("Token rotated.");
        setConfirm(null);
        await load();
        if (result?.created?.token) setFresh({ token: result.created.token, prefix: result.created.prefix });
      } else {
        await api(projectId, `${base}/${encodeURIComponent(token.id)}`, { method: "DELETE" });
        toast.success("Token revoked.");
        setConfirm(null);
        await load();
      }
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const columns = [
    {
      key: "token",
      header: "Token",
      render: (token) => <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-card text-muted-foreground">
          <KeyRound className="h-4 w-4" />
        </div>
        <span className="font-mono text-xs text-foreground">{token.prefix}…</span>
      </div>,
    },
    { key: "status", header: "Status", render: (token) => <StatusPill status={token.revokedAt ? "revoked" : "active"} map={TOKEN_STATUS_MAP} /> },
    { key: "created", header: "Created", render: (token) => <span className="text-sm tabular-nums text-text-secondary">{formatDate(token.createdAt)}</span> },
    { key: "revoked", header: "Revoked", render: (token) => <span className="text-sm tabular-nums text-text-secondary">{token.revokedAt ? formatDate(token.revokedAt) : "—"}</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (token) => (token.revokedAt ? null : <ActionMenu
        label={`Actions for token ${token.prefix}`}
        items={[
          { icon: RotateCw, label: "Rotate", disabled: busy, onSelect: () => setConfirm({ action: "rotate", token }) },
          { separator: true },
          { icon: Trash2, label: "Revoke", variant: "destructive", disabled: busy, onSelect: () => setConfirm({ action: "revoke", token }) },
        ]}
      />),
    },
  ];

  const newTokenButton = <Button className={primaryButtonClass} size="sm" disabled={creating} onClick={create}>
    {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}New Token
  </Button>;

  return <div className="space-y-6">
    <SectionCard title="Tokens" description="Each agent authenticates with a token. Rotating issues a replacement and revokes the old one." action={newTokenButton} bodyPadding={false}>
      {tokens.status === "loading" ? <LoadingArea className="py-10" label="Loading tokens" /> : <DataTable
        className="rounded-none border-0"
        columns={columns}
        data={tokens.items}
        getRowKey={(token) => token.id}
        empty={<EmptyState icon={KeyRound} title="No tokens yet" description="Create one to connect an agent." />}
      />}
    </SectionCard>

    <TokenOnceDialog
      token={fresh?.token}
      agentCommand={fresh ? `node connector/agent.mjs --url wss://<gateway>/_connector --token ${fresh.token} --targets ${(connector.allowedTargets ?? []).join(",")}` : ""}
      onClose={() => setFresh(null)}
    />

    <ConfirmDialog
      open={!!confirm}
      onOpenChange={(open) => { if (!open) setConfirm(null); }}
      title={confirm?.action === "rotate" ? "Rotate token" : "Revoke token"}
      confirmLabel={confirm?.action === "rotate" ? "Rotate" : "Revoke"}
      icon={confirm?.action === "rotate" ? RotateCw : Trash2}
      busy={busy}
      onConfirm={runConfirmed}
    >
      {confirm?.action === "rotate"
        ? <>Rotate <span className="font-mono text-foreground">{confirm?.token.prefix}…</span>? It is revoked now and a replacement is shown once. Agents using it disconnect until you update them.</>
        : <>Revoke <span className="font-mono text-foreground">{confirm?.token.prefix}…</span>? Agents using it disconnect immediately. This can&apos;t be undone.</>}
    </ConfirmDialog>
  </div>;
}

function ConnectorEditPage({ projectId, connector, defaultSection, onBack, onSaved, onDelete }) {
  const [name, setName] = useState(connector.name);
  const [description, setDescription] = useState(connector.description ?? "");
  const [targets, setTargets] = useState((connector.allowedTargets ?? []).join(", "));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!name.trim()) {
      toast.error("Give the connector a name first.");
      return;
    }
    const patch = {};
    if (name.trim() !== connector.name) patch.name = name.trim();
    if (description.trim() !== (connector.description ?? "")) patch.description = description.trim();
    const nextTargets = parseTargets(targets);
    if (nextTargets.join(",") !== (connector.allowedTargets ?? []).join(",")) patch.allowedTargets = nextTargets;
    if (Object.keys(patch).length === 0) {
      toast("No changes to save.");
      return;
    }
    setSaving(true);
    try {
      await api(projectId, `/${encodeURIComponent(connector.id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      toast.success("Saved.");
      await onSaved();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const allowedTargets = connector.allowedTargets ?? [];

  return <EditorShell
    back={{ label: "All Connectors", onClick: onBack }}
    title={connector.name}
    status={connector.status}
    statusMap={CONNECTOR_STATUS_MAP}
    badges={<Badge variant="outline">{plural(connector.agentCount ?? 0, "agent")} online</Badge>}
    meta={connector.statusMessage || undefined}
    actions={<Button className={primaryButtonClass} disabled={saving} onClick={save}>
      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{saving ? "Saving…" : "Save Changes"}
    </Button>}
    nav={CONNECTOR_NAV}
    defaultSection={defaultSection}
  >
    {({ active }) => <div>
      <div hidden={active !== "overview"} className="space-y-6">
        <SectionCard title="Health" description="Agents enforce the allow-list locally; the gateway checks it too.">
          <dl className="grid gap-4 sm:grid-cols-2">
            <div><dt className="text-xs text-text-secondary">Status</dt><dd className="mt-1"><StatusPill status={connector.status} map={CONNECTOR_STATUS_MAP} /></dd></div>
            <div><dt className="text-xs text-text-secondary">Agents online</dt><dd className="mt-1 text-sm tabular-nums text-foreground">{connector.agentCount ?? 0}</dd></div>
            <div><dt className="text-xs text-text-secondary">Last seen</dt><dd className="mt-1 text-sm text-foreground">{formatDateTime(connector.lastSeenAt)}</dd></div>
            <div><dt className="text-xs text-text-secondary">Created</dt><dd className="mt-1 text-sm text-foreground">{formatDate(connector.createdAt)}</dd></div>
            <div className="min-w-0 sm:col-span-2">
              <dt className="text-xs text-text-secondary">Connector ID</dt>
              <dd className="mt-1 flex min-w-0 items-center gap-1.5">
                <span className="truncate font-mono text-xs text-foreground">{connector.id}</span>
                <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label="Copy connector ID" onClick={() => copyText(connector.id, "Connector ID")}>
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </dd>
            </div>
          </dl>
        </SectionCard>
        <SectionCard title="Allowed targets" description="The only private backends this connector's agents will reach.">
          {allowedTargets.length
            ? <div className="flex flex-wrap gap-2">{allowedTargets.map((target) => <Badge key={target} variant="neutral" className="font-mono">{target}</Badge>)}</div>
            : <p className="text-sm text-text-secondary">None — no traffic can flow.</p>}
        </SectionCard>
      </div>
      <div hidden={active !== "tokens"}>
        <TokensSection projectId={projectId} connector={connector} />
      </div>
      <div hidden={active !== "settings"} className="space-y-6">
        <SectionCard title="General">
          <div className="grid gap-4">
            <Field label="Name" htmlFor="connector-edit-name">
              <Input id="connector-edit-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={128} />
            </Field>
            <Field label="Description (optional)" htmlFor="connector-edit-description">
              <Textarea id="connector-edit-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={2} maxLength={1024} />
            </Field>
            <Field label="Allowed targets" htmlFor="connector-edit-targets" hint="Comma-separated host:port or CIDR:port. Leave empty to block all traffic.">
              <Textarea id="connector-edit-targets" value={targets} onChange={(event) => setTargets(event.target.value)} rows={2} spellCheck={false} className="font-mono text-xs" placeholder="orders.internal:8080, 10.0.0.0/8:8080" />
            </Field>
          </div>
        </SectionCard>
        <SectionCard title="Danger zone" description="Deleting a connector revokes its tokens and disconnects its agents.">
          <Button className={destructiveButtonClass} onClick={() => onDelete(connector)}><Trash2 className="h-4 w-4" />Delete Connector</Button>
        </SectionCard>
      </div>
    </div>}
  </EditorShell>;
}

// --- Create dialog --------------------------------------------------------------

function CreateConnectorDialog({ open, onOpenChange, projectId, onCreated }) {
  const [name, setName] = useState("");
  const [targets, setTargets] = useState("");
  const [busy, setBusy] = useState(false);

  const close = () => {
    onOpenChange(false);
    setName("");
    setTargets("");
  };

  const submit = async (event) => {
    event?.preventDefault();
    if (!name.trim()) {
      toast.error("Give the connector a name first.");
      return;
    }
    setBusy(true);
    try {
      const created = await api(projectId, "", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), allowedTargets: parseTargets(targets) }),
      });
      toast.success(`"${name.trim()}" created.`);
      close();
      await onCreated(created);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open={open} onOpenChange={(next) => { if (!next) close(); else onOpenChange(true); }}>
    <DialogContent className="max-w-xl bg-background">
      <DialogHeader>
        <DialogTitle>New Connector</DialogTitle>
        <DialogDescription>Agents dial out, so your firewall needs no inbound rules. You&apos;ll create an agent token next.</DialogDescription>
      </DialogHeader>
      <form className="grid gap-4" onSubmit={submit}>
        <Field label="Name" htmlFor="connector-name">
          <Input id="connector-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="vpc-a" autoFocus maxLength={128} />
        </Field>
        <Field label="Allowed targets" htmlFor="connector-targets" hint="Comma-separated host:port or CIDR:port.">
          <Textarea id="connector-targets" value={targets} onChange={(event) => setTargets(event.target.value)} placeholder="orders.internal:8080, 10.0.0.0/8:8080" rows={2} spellCheck={false} className="font-mono text-xs" />
        </Field>
      </form>
      <DialogFooter>
        <Button variant="outline" className={cancelButtonClass} onClick={close}>Cancel</Button>
        <Button className={primaryButtonClass} disabled={busy} onClick={submit}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Create Connector
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

// --- Screen ---------------------------------------------------------------------

export function ConnectorsScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [landing, setLanding] = useState(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [recordId, setRecordId] = useRecordParam();
  const writable = can("pods.connector.write");

  // Refreshes in place (no loading flash) so an open edit page stays put.
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

  const connectors = state.items;
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return connectors.filter((entry) => {
      if (status !== "all" && entry.status !== status) return false;
      return !query || `${entry.name} ${entry.description ?? ""} ${(entry.allowedTargets ?? []).join(" ")}`.toLowerCase().includes(query);
    });
  }, [connectors, search, status]);

  const pager = usePagination(filtered, { resetKey: `${search}|${status}` });

  const stats = useMemo(() => [
    { label: "Connectors", value: String(connectors.length), footer: "Private links" },
    { label: "Available", value: String(connectors.filter((entry) => entry.status === "AVAILABLE").length), footer: "Agents connected" },
    { label: "Agents online", value: String(connectors.reduce((sum, entry) => sum + (entry.agentCount ?? 0), 0)), footer: "Across all connectors" },
    { label: "Need attention", value: String(connectors.filter((entry) => entry.status === "DEGRADED" || entry.status === "FAILED").length), footer: "Degraded or failed" },
  ], [connectors]);

  const header = <ScreenHeader
    title="Connectors"
    description="Outbound agents that reach backends in your private network. Agents dial out, so no inbound firewall rules are needed."
    actions={writable ? <Button className={primaryButtonClass} onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New Connector</Button> : null}
  />;

  if (!writable) {
    return <MainScreenWrapper>
      {header}
      <div className="rounded-xl border border-border bg-surface-subtle">
        <EmptyState icon={LockKeyhole} title="Access unavailable" description="Your current team access does not allow this screen." />
      </div>
    </MainScreenWrapper>;
  }

  const openRecord = (id, section = null) => {
    setLanding(section);
    setRecordId(id);
  };

  const closeRecord = () => openRecord(null);

  const remove = async () => {
    const target = deleteTarget;
    setDeleting(true);
    try {
      await api(project.id, `/${encodeURIComponent(target.id)}`, { method: "DELETE" });
      toast.success(`Deleted "${target.name}".`);
      setDeleteTarget(null);
      if (recordId === target.id) closeRecord();
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setDeleting(false);
    }
  };

  const dialogs = <>
    <CreateConnectorDialog
      open={creating}
      onOpenChange={setCreating}
      projectId={project.id}
      onCreated={async (created) => {
        await refresh();
        if (created?.id) openRecord(created.id, "tokens");
      }}
    />
    <ConfirmDialog
      open={!!deleteTarget}
      onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      title="Delete connector"
      confirmLabel="Delete"
      busy={deleting}
      onConfirm={remove}
    >
      Delete <span className="font-medium text-foreground">{deleteTarget?.name}</span>? Its tokens are revoked and its agents disconnect. This can&apos;t be undone.
    </ConfirmDialog>
  </>;

  const openConnector = recordId ? connectors.find((entry) => entry.id === recordId) : null;
  if (openConnector) {
    return <>
      <ConnectorEditPage
        key={openConnector.id}
        projectId={project.id}
        connector={openConnector}
        defaultSection={landing ?? "overview"}
        onBack={closeRecord}
        onSaved={refresh}
        onDelete={setDeleteTarget}
      />
      {dialogs}
    </>;
  }

  const columns = [
    {
      key: "name",
      header: "Connector",
      render: (entry) => <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-card text-muted-foreground">
          <Cable className="h-4 w-4" />
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-medium text-foreground">{entry.name}</span>
          <span className="block max-w-[26rem] truncate text-xs text-text-secondary">{entry.description || entry.statusMessage || "No description"}</span>
        </div>
      </div>,
    },
    { key: "status", header: "Status", render: (entry) => <StatusPill status={entry.status} map={CONNECTOR_STATUS_MAP} /> },
    {
      key: "targets",
      header: "Allowed targets",
      render: (entry) => {
        const targets = entry.allowedTargets ?? [];
        if (!targets.length) return <span className="text-sm text-text-tertiary">None</span>;
        return <span className="text-sm text-text-secondary">
          <span className="font-mono text-xs">{targets[0]}</span>{targets.length > 1 ? ` +${targets.length - 1} more` : ""}
        </span>;
      },
    },
    { key: "agents", header: "Agents", align: "right", className: "text-right", render: (entry) => <span className="text-sm tabular-nums text-text-secondary">{entry.agentCount ?? 0}</span> },
    { key: "lastSeen", header: "Last seen", render: (entry) => <span className="text-sm tabular-nums text-text-secondary">{formatDateTime(entry.lastSeenAt)}</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (entry) => <ActionMenu
        label={`Actions for ${entry.name}`}
        items={[
          { icon: Pencil, label: "Open", onSelect: () => openRecord(entry.id) },
          { icon: KeyRound, label: "Manage tokens", onSelect: () => openRecord(entry.id, "tokens") },
          { icon: Copy, label: "Copy ID", onSelect: () => copyText(entry.id, "Connector ID") },
          { separator: true },
          { icon: Trash2, label: "Delete", variant: "destructive", onSelect: () => setDeleteTarget(entry) },
        ]}
      />,
    },
  ];

  return <MainScreenWrapper>
    {header}

    <StatsBar stats={stats} />

    <Toolbar>
      <div className="flex flex-wrap items-center gap-2">
        <FilterDropdown label="Status" value={status} onValueChange={setStatus} options={STATUS_FILTER_OPTIONS} height="h-9" />
      </div>
      <SearchInput value={search} onChange={setSearch} placeholder="Search connectors, targets…" />
    </Toolbar>

    {state.status === "loading" ? <LoadingArea label="Loading connectors" /> : null}
    {state.status === "error" ? <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={Cable}
      title="Connectors unavailable"
      description={state.error}
      action={<Button variant="outline" onClick={() => { setState({ status: "loading", items: [], error: null }); refresh(); }}>Retry</Button>}
    /></div> : null}
    {state.status === "ready" ? <div className="space-y-5">
      <DataTable
        columns={columns}
        data={pager.pageItems}
        getRowKey={(entry) => entry.id}
        onRowClick={(entry) => openRecord(entry.id)}
        empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
          icon={Cable}
          title={connectors.length ? "No connectors match your filters" : "No connectors yet"}
          description={connectors.length
            ? "Try clearing the search or status filter."
            : "Create one, then run its agent inside your private network."}
          action={connectors.length ? null : <Button className={primaryButtonClass} onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New Connector</Button>}
        /></div>}
      />
      <ListPagination {...pager} itemLabel="connectors" />
    </div> : null}

    {dialogs}
  </MainScreenWrapper>;
}
