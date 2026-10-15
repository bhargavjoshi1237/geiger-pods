"use client";

// Access tokens (`/settings/tokens`): create (kind, scopes picker by
// permission group, expiry), list with prefix hints, revoke. The raw value is
// returned exactly once, so it is shown once in a dialog with copy buttons.

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Copy, Eye, KeyRound, Loader2, LockKeyhole, Plus, Trash2 } from "lucide-react";
import { DataTable, EmptyState, Field, LoadingArea, ScreenHeader, SearchInput, SectionCard, StatsBar, StatusPill, Toolbar } from "@/components/internal/shared/screen_kit";
import { MainScreenWrapper, SecondaryScreenWrapper } from "@/components/internal/shared/screen_wrappers";
import { ListPagination, usePagination } from "@/components/internal/shared/pagination";
import { EditorHeader } from "@/components/internal/shared/editor_shell";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Checkbox } from "@geiger/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { useRecordParam } from "@/lib/hooks/use-record-param";
import FilterDropdown from "../overview/filter_dropdown";

async function api(projectId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/access-tokens${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

const SCOPE_GROUPS = [
  { group: "APIs", scopes: ["pods.apis.view", "pods.api.create", "pods.api.update", "pods.api.delete", "pods.api.*"] },
  { group: "Build", scopes: ["pods.route.write", "pods.integration.write", "pods.model.write", "pods.authorizer.write"] },
  { group: "Release", scopes: ["pods.deployment.create", "pods.stage.write", "pods.stage.promote", "pods.test.invoke"] },
  { group: "Consumers", scopes: ["pods.api_key.write", "pods.usage_plan.write"] },
  { group: "Security", scopes: ["pods.secret.write", "pods.secret.use"] },
  { group: "Operations", scopes: ["pods.logs.view", "pods.export.write"] },
];

const TOKEN_STATUS_MAP = {
  active: { label: "Active", variant: "success" },
  expired: { label: "Expired", variant: "warning" },
  revoked: { label: "Revoked", variant: "neutral" },
};

const KIND_LABEL = { personal: "Personal", service: "Service" };

const KIND_FILTER_OPTIONS = [
  { value: "all", label: "All Kinds" },
  { value: "personal", label: "Personal" },
  { value: "service", label: "Service" },
];

const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "All Statuses" },
  { value: "active", label: "Active" },
  { value: "expired", label: "Expired" },
  { value: "revoked", label: "Revoked" },
];

const formatDate = (value) => (value ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");

function tokenStatus(token) {
  if (token.revokedAt) return "revoked";
  if (token.expiresAt && new Date(token.expiresAt).getTime() < Date.now()) return "expired";
  return "active";
}

function copy(value, label) {
  navigator.clipboard?.writeText(value).then(
    () => toast.success(`${label} copied.`),
    () => toast.error(`Couldn't copy the ${label.toLowerCase()}.`),
  );
}

const outlineQuiet = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

function CreateTokenDialog({ open, onOpenChange, onCreated }) {
  const { project } = useProject();
  // Keyed by `open` in the parent, so every open starts from an empty form.
  const [name, setName] = useState("");
  const [kind, setKind] = useState("personal");
  const [expiresAt, setExpiresAt] = useState("");
  const [scopes, setScopes] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  const toggleScope = (scope, on) => setScopes((current) => {
    const next = new Set(current);
    if (on) next.add(scope);
    else next.delete(scope);
    return next;
  });

  const submit = async () => {
    if (!name.trim()) {
      toast.error("Give the token a name first.");
      return;
    }
    setBusy(true);
    try {
      const result = await api(project.id, "", {
        method: "POST",
        body: JSON.stringify({ kind, name: name.trim(), scopes: [...scopes], expiresAt: expiresAt || null }),
      });
      toast.success("Token created — copy it now.");
      onCreated({ ...result, name: result?.name ?? name.trim() });
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-xl bg-background">
      <DialogHeader>
        <DialogTitle>Create Access Token</DialogTitle>
        <DialogDescription>Personal tokens need an expiry within a year. Service tokens can&apos;t exceed your own scopes.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <Field label="Name" htmlFor="token-name">
          <Input id="token-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="laptop cli" maxLength={128} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Kind" htmlFor="token-kind">
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger id="token-kind" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="personal">Personal</SelectItem>
                <SelectItem value="service">Service</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Expires on" htmlFor="token-expiry">
            <Input id="token-expiry" type="date" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
          </Field>
        </div>
        <Field label="Scopes" hint={kind === "personal" ? "Leave empty to inherit your current permissions." : "A service token carries exactly these scopes."}>
          <div className="max-h-64 space-y-3 overflow-y-auto rounded-lg border border-border bg-surface-subtle p-3">
            {SCOPE_GROUPS.map((entry) => <div key={entry.group}>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">{entry.group}</p>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {entry.scopes.map((scope) => <div key={scope} className="flex items-center gap-2">
                  <Checkbox id={`token-scope-${scope}`} checked={scopes.has(scope)} onCheckedChange={(value) => toggleScope(scope, value === true)} />
                  <Label htmlFor={`token-scope-${scope}`} className="font-mono text-xs font-normal">{scope}</Label>
                </div>)}
              </div>
            </div>)}
          </div>
        </Field>
      </div>
      <DialogFooter>
        <Button variant="outline" className={outlineQuiet} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button className="bg-primary text-primary-foreground hover:bg-primary/90" disabled={busy} onClick={submit}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Create Token
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function FreshTokenDialog({ fresh, onOpenChange }) {
  const value = fresh?.token ?? "";
  return <Dialog open={!!fresh?.token} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-xl bg-background">
      <DialogHeader>
        <DialogTitle>Copy Your Token</DialogTitle>
        <DialogDescription>{fresh?.name ? <><span className="font-medium text-foreground">{fresh.name}</span> is ready. </> : null}This is the only time the value is shown.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <Field label="Token" htmlFor="fresh-token">
          <div className="flex items-center gap-2">
            <Input id="fresh-token" readOnly value={value} spellCheck={false} className="font-mono text-xs" onFocus={(event) => event.target.select()} />
            <Button variant="outline" className={outlineQuiet} onClick={() => copy(value, "Token")}><Copy className="h-4 w-4" />Copy</Button>
          </div>
        </Field>
        <Field label="Sign in the CLI">
          <div className="flex items-center gap-2">
            <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-border bg-surface-subtle px-3 py-2 font-mono text-xs">pods login --token {value}</pre>
            <Button variant="ghost" size="icon-sm" aria-label="Copy CLI command" className="text-muted-foreground hover:bg-surface-active hover:text-foreground" onClick={() => copy(`pods login --token ${value}`, "Command")}>
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </Field>
        <p className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Store it somewhere safe now. If you lose it, revoke the token and create a new one.
        </p>
      </div>
      <DialogFooter>
        <Button className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => onOpenChange(false)}>Done</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function TokenDetail({ token, onBack, onRevoke }) {
  const status = tokenStatus(token);
  const facts = [
    ["Kind", KIND_LABEL[token.kind] ?? token.kind],
    ["Prefix", <span key="prefix" className="font-mono text-xs">{token.prefix}…</span>],
    ["Created", formatDate(token.createdAt)],
    ["Expires", token.expiresAt ? formatDate(token.expiresAt) : "Never"],
    ["Last used", token.lastUsedAt ? formatDate(token.lastUsedAt) : "Never"],
    ["Revoked", token.revokedAt ? formatDate(token.revokedAt) : "—"],
  ];
  const scopes = token.scopes ?? [];
  return <SecondaryScreenWrapper>
    <EditorHeader
      back={{ label: "All Access Tokens", onClick: onBack }}
      title={token.name}
      status={status}
      statusMap={TOKEN_STATUS_MAP}
      meta={`${KIND_LABEL[token.kind] ?? token.kind} token · ${token.prefix}…`}
    />
    <div className="mt-6 space-y-6">
      <SectionCard title="Details">
        <dl className="grid gap-4 sm:grid-cols-2">
          {facts.map(([label, value]) => <div key={label}>
            <dt className="text-xs text-text-secondary">{label}</dt>
            <dd className="mt-1 text-sm text-foreground">{value}</dd>
          </div>)}
        </dl>
      </SectionCard>
      <SectionCard title="Scopes" description={scopes.length ? `${scopes.length} scope${scopes.length === 1 ? "" : "s"} granted.` : "No fixed scopes."}>
        {scopes.length
          ? <div className="flex flex-wrap gap-1.5">{scopes.map((scope) => <Badge key={scope} variant="neutral" className="font-mono">{scope}</Badge>)}</div>
          : <p className="text-sm text-text-secondary">This token acts with its owner&apos;s current permissions.</p>}
      </SectionCard>
      {onRevoke && status !== "revoked" ? <SectionCard title="Danger zone" description="Revoking stops every client using this token immediately.">
        <Button className="bg-red-500/90 text-white hover:bg-red-500" onClick={() => onRevoke(token)}><Trash2 className="h-4 w-4" /> Revoke Token</Button>
      </SectionCard> : null}
    </div>
  </SecondaryScreenWrapper>;
}

export function TokensScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState(null);
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [revoking, setRevoking] = useState(false);
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [recordId, setRecordId] = useRecordParam();
  const writable = can("pods.token.write");

  const refresh = useCallback(async () => {
    try {
      const data = await api(project.id, "");
      setState({ status: "ready", items: data.items ?? data ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [project.id]);

  useEffect(() => {
    if (!writable) return undefined;
    let alive = true;
    api(project.id, "").then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? data ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id, writable]);

  const tokens = state.items;

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return tokens.filter((token) => {
      if (kindFilter !== "all" && token.kind !== kindFilter) return false;
      if (statusFilter !== "all" && tokenStatus(token) !== statusFilter) return false;
      return !query || `${token.name} ${token.prefix ?? ""} ${(token.scopes ?? []).join(" ")}`.toLowerCase().includes(query);
    });
  }, [tokens, search, kindFilter, statusFilter]);

  const pager = usePagination(filtered, { resetKey: `${search}|${kindFilter}|${statusFilter}` });

  const stats = useMemo(() => {
    const active = tokens.filter((token) => tokenStatus(token) === "active");
    return [
      { label: "Active", value: String(active.length), footer: "Usable right now" },
      { label: "Personal", value: String(active.filter((token) => token.kind === "personal").length), footer: "Act as their owner" },
      { label: "Service", value: String(active.filter((token) => token.kind === "service").length), footer: "Fixed scopes" },
      { label: "Inactive", value: String(tokens.length - active.length), footer: "Revoked or expired" },
    ];
  }, [tokens]);

  const revoke = async () => {
    const token = revokeTarget;
    if (!token) return;
    setRevoking(true);
    try {
      await api(project.id, `/${encodeURIComponent(token.id)}`, { method: "DELETE" });
      toast.success(`Revoked "${token.name}".`);
      setRevokeTarget(null);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setRevoking(false);
    }
  };

  const revokeDialog = <Dialog open={!!revokeTarget} onOpenChange={(open) => { if (!open) setRevokeTarget(null); }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Revoke token</DialogTitle>
        <DialogDescription>
          Revoke <span className="font-medium text-foreground">{revokeTarget?.name}</span>? Anything still using it stops working immediately. This action can&apos;t be undone.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" onClick={() => setRevokeTarget(null)}>Cancel</Button>
        <Button className="bg-red-500/90 text-white hover:bg-red-500" disabled={revoking} onClick={revoke}>
          {revoking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Revoke
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;

  if (!writable) {
    return <MainScreenWrapper>
      <ScreenHeader title="Access Tokens" description="Credentials for the CLI and automation." />
      <div className="rounded-xl border border-border bg-surface-subtle">
        <EmptyState icon={LockKeyhole} title="Access unavailable" description="Managing access tokens needs the Manage personal access tokens permission." />
      </div>
    </MainScreenWrapper>;
  }

  const openToken = tokens.find((token) => token.id === recordId) ?? null;
  if (recordId && openToken) {
    return <>
      <TokenDetail token={openToken} onBack={() => setRecordId(null)} onRevoke={setRevokeTarget} />
      {revokeDialog}
    </>;
  }

  const createButton = <Button className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => setCreating(true)}>
    <Plus className="h-4 w-4" /> New Token
  </Button>;

  const columns = [
    {
      key: "name",
      header: "Token",
      render: (token) => <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-card text-muted-foreground">
          <KeyRound className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{token.name}</p>
          <p className="truncate font-mono text-xs text-text-secondary">{token.prefix}…</p>
        </div>
      </div>,
    },
    { key: "kind", header: "Kind", render: (token) => <Badge variant="outline">{KIND_LABEL[token.kind] ?? token.kind}</Badge> },
    {
      key: "scopes",
      header: "Scopes",
      render: (token) => <span className="text-sm text-text-secondary">{token.scopes?.length ? `${token.scopes.length} scope${token.scopes.length === 1 ? "" : "s"}` : "Owner's permissions"}</span>,
    },
    { key: "status", header: "Status", render: (token) => <StatusPill status={tokenStatus(token)} map={TOKEN_STATUS_MAP} /> },
    { key: "lastUsed", header: "Last used", render: (token) => <span className="text-sm tabular-nums text-text-secondary">{token.lastUsedAt ? formatDate(token.lastUsedAt) : "Never"}</span> },
    { key: "expires", header: "Expires", render: (token) => <span className="text-sm tabular-nums text-text-secondary">{token.expiresAt ? formatDate(token.expiresAt) : "Never"}</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (token) => <ActionMenu
        label={`Actions for ${token.name}`}
        items={[
          { icon: Eye, label: "View", onSelect: () => setRecordId(token.id) },
          { icon: Copy, label: "Copy prefix", onSelect: () => copy(token.prefix, "Prefix") },
          !token.revokedAt && { separator: true },
          !token.revokedAt && { icon: Trash2, label: "Revoke", destructive: true, onSelect: () => setRevokeTarget(token) },
        ]}
      />,
    },
  ];

  return <MainScreenWrapper>
    <ScreenHeader
      title="Access Tokens"
      description="Personal tokens act with your current permissions; service tokens carry fixed scopes. Values are shown once."
      actions={createButton}
    />

    <StatsBar stats={stats} />

    <Toolbar>
      <div className="flex flex-wrap items-center gap-2">
        <FilterDropdown label="Kind" value={kindFilter} onValueChange={setKindFilter} options={KIND_FILTER_OPTIONS} height="h-9" />
        <FilterDropdown label="Status" value={statusFilter} onValueChange={setStatusFilter} options={STATUS_FILTER_OPTIONS} height="h-9" />
      </div>
      <SearchInput value={search} onChange={setSearch} placeholder="Search tokens, prefixes, scopes…" />
    </Toolbar>

    {state.status === "loading" ? <LoadingArea label="Loading access tokens" /> : null}
    {state.status === "error" ? <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={KeyRound}
      title="Tokens unavailable"
      description={state.error}
      action={<Button variant="outline" onClick={() => { setState({ status: "loading", items: [], error: null }); refresh(); }}>Retry</Button>}
    /></div> : null}
    {state.status === "ready" ? <div className="space-y-5">
      <DataTable
        columns={columns}
        data={pager.pageItems}
        getRowKey={(token) => token.id}
        onRowClick={(token) => setRecordId(token.id)}
        empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
          icon={KeyRound}
          title={tokens.length ? "No tokens match your filters" : "No tokens yet"}
          description={tokens.length ? "Try clearing the search or filters." : "Create one for the CLI, then sign in with pods login --token."}
          action={tokens.length ? null : createButton}
        /></div>}
      />
      <ListPagination {...pager} itemLabel="tokens" />
    </div> : null}

    <CreateTokenDialog
      key={creating ? "create-open" : "create-closed"}
      open={creating}
      onOpenChange={setCreating}
      onCreated={(result) => { setCreating(false); setFresh(result); void refresh(); }}
    />
    <FreshTokenDialog fresh={fresh} onOpenChange={(open) => { if (!open) setFresh(null); }} />
    {revokeDialog}
  </MainScreenWrapper>;
}
