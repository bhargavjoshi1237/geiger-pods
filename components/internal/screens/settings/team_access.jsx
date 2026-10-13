"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, Loader2, LockKeyhole, ShieldCheck, Trash2, UserPlus, UserRound } from "lucide-react";
import { DataTable, EmptyState, Field, LoadingArea, ScreenHeader, SearchInput, StatsBar, StatusPill, Toolbar } from "@/components/internal/shared/screen_kit";
import { MainScreenWrapper } from "@/components/internal/shared/screen_wrappers";
import { ListPagination, usePagination } from "@/components/internal/shared/pagination";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { toast } from "sonner";
import rbacConfig from "@/geiger-rbac.config";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import FilterDropdown from "../overview/filter_dropdown";

async function api(projectId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/role-grants${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

const SYSTEM_ROLES = rbacConfig.systemRoles.map((role) => ({ key: role.key, name: role.name, description: role.description }));
const CUSTOM_ROLE = "__custom";
const ROLE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

const GRANT_STATUS_MAP = {
  active: { label: "Active", variant: "success" },
  suspended: { label: "Suspended", variant: "warning" },
  revoked: { label: "Revoked", variant: "neutral" },
};

const ACCESS_FILTER_OPTIONS = [
  { value: "all", label: "All Access" },
  { value: "project", label: "All APIs" },
  { value: "scoped", label: "Scoped to APIs" },
];

const formatDate = (value) => (value ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
const roleLabel = (grant) => grant.roleName ?? grant.roleKey ?? "Unknown role";
const scopedApis = (grant) => grant.scope?.api ?? [];

function copy(value, label) {
  navigator.clipboard?.writeText(value).then(
    () => toast.success(`${label} copied.`),
    () => toast.error(`Couldn't copy the ${label.toLowerCase()}.`),
  );
}

function GrantRoleDialog({ open, onOpenChange, onSubmit, busy }) {
  // Keyed by `open` in the parent, so the form starts empty every time.
  const [userId, setUserId] = useState("");
  const [roleChoice, setRoleChoice] = useState("member");
  const [customRole, setCustomRole] = useState("");
  const [apis, setApis] = useState("");

  const submit = () => {
    const roleKey = roleChoice === CUSTOM_ROLE ? customRole.trim() : roleChoice;
    if (!userId.trim()) {
      toast.error("Enter the teammate's user ID first.");
      return;
    }
    if (!ROLE_KEY_PATTERN.test(roleKey)) {
      toast.error("Role keys are lowercase letters, digits and underscores, starting with a letter.");
      return;
    }
    const apiIds = apis.split(",").map((entry) => entry.trim()).filter(Boolean);
    onSubmit({
      userId: userId.trim(),
      roleKey,
      ...(apiIds.length > 0 ? { scope: { api: apiIds } } : {}),
    });
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-xl bg-background">
      <DialogHeader>
        <DialogTitle>Grant Role</DialogTitle>
        <DialogDescription>Give a teammate a product role. You can never grant a role holding a permission you lack yourself.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <Field label="User ID" htmlFor="grant-user">
          <Input id="grant-user" autoFocus value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="00000000-0000-4000-8000-000000000000" spellCheck={false} className="font-mono text-xs" />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Role" htmlFor="grant-role">
            <Select value={roleChoice} onValueChange={setRoleChoice}>
              <SelectTrigger id="grant-role" className="w-full"><SelectValue placeholder="Select role" /></SelectTrigger>
              <SelectContent>
                {SYSTEM_ROLES.map((role) => <SelectItem key={role.key} value={role.key}>{role.name}</SelectItem>)}
                <SelectItem value={CUSTOM_ROLE}>Custom role…</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {roleChoice === CUSTOM_ROLE ? <Field label="Role key" htmlFor="grant-role-key">
            <Input id="grant-role-key" value={customRole} onChange={(event) => setCustomRole(event.target.value)} placeholder="api_developer" spellCheck={false} className="font-mono text-xs" />
          </Field> : <div />}
        </div>
        {roleChoice !== CUSTOM_ROLE ? <p className="-mt-2 text-xs text-text-secondary">{SYSTEM_ROLES.find((role) => role.key === roleChoice)?.description}</p> : null}
        <Field label="API IDs (optional)" htmlFor="grant-apis" hint="Comma-separated. Leave empty to grant the role on every API in the project.">
          <Input id="grant-apis" value={apis} onChange={(event) => setApis(event.target.value)} placeholder="a1b2c3d4e5, f6g7h8i9j0" spellCheck={false} className="font-mono text-xs" />
        </Field>
      </div>
      <DialogFooter>
        <Button variant="outline" className="border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button className="bg-primary text-primary-foreground hover:bg-primary/90" disabled={busy} onClick={submit}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Grant Role
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function TeamAccessScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [granting, setGranting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [accessFilter, setAccessFilter] = useState("all");
  const manageable = can("pods.role.grant");

  const refresh = useCallback(async () => {
    try {
      const data = await api(project.id, "");
      setState({ status: "ready", items: data.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [project.id]);

  useEffect(() => {
    if (!manageable) return undefined;
    let alive = true;
    api(project.id, "").then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id, manageable]);

  const grants = state.items;

  const roleOptions = useMemo(() => {
    const seen = new Map();
    for (const grant of grants) if (grant.roleKey && !seen.has(grant.roleKey)) seen.set(grant.roleKey, roleLabel(grant));
    return [{ value: "all", label: "All Roles" }, ...[...seen].map(([value, label]) => ({ value, label }))];
  }, [grants]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return grants.filter((grant) => {
      if (roleFilter !== "all" && grant.roleKey !== roleFilter) return false;
      const scoped = scopedApis(grant).length > 0;
      if (accessFilter === "project" && scoped) return false;
      if (accessFilter === "scoped" && !scoped) return false;
      return !query || `${grant.userId} ${grant.roleKey ?? ""} ${grant.roleName ?? ""} ${scopedApis(grant).join(" ")}`.toLowerCase().includes(query);
    });
  }, [grants, search, roleFilter, accessFilter]);

  const pager = usePagination(filtered, { resetKey: `${search}|${roleFilter}|${accessFilter}` });

  const stats = useMemo(() => [
    { label: "Grants", value: String(grants.length), footer: "Product roles in force" },
    { label: "Members", value: String(new Set(grants.map((grant) => grant.userId)).size), footer: "With a product grant" },
    { label: "Scoped", value: String(grants.filter((grant) => scopedApis(grant).length > 0).length), footer: "Narrowed to specific APIs" },
    { label: "Roles in use", value: String(new Set(grants.map((grant) => grant.roleKey)).size), footer: "Distinct roles granted" },
  ], [grants]);

  const grant = async (body) => {
    setBusy(true);
    try {
      await api(project.id, "", { method: "POST", body: JSON.stringify(body) });
      toast.success("Role granted.");
      setGranting(false);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    const target = revokeTarget;
    if (!target) return;
    setBusy(true);
    try {
      await api(project.id, `?id=${encodeURIComponent(target.id)}`, { method: "DELETE" });
      toast.success("Grant revoked.");
      setRevokeTarget(null);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  if (!manageable) {
    return <MainScreenWrapper>
      <ScreenHeader title="Team & Access" description="Product roles for the people working in this project." />
      <div className="rounded-xl border border-border bg-surface-subtle">
        <EmptyState icon={LockKeyhole} title="Access unavailable" description="Managing product roles needs the Grant product roles permission." />
      </div>
    </MainScreenWrapper>;
  }

  const grantButton = <Button className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => setGranting(true)}>
    <UserPlus className="h-4 w-4" /> Grant Role
  </Button>;

  const columns = [
    {
      key: "member",
      header: "Member",
      render: (row) => <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-card text-muted-foreground">
          <UserRound className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate font-mono text-xs font-medium text-foreground">{row.userId}</p>
          <p className="truncate text-xs text-text-secondary">Granted {formatDate(row.createdAt)}</p>
        </div>
      </div>,
    },
    {
      key: "role",
      header: "Role",
      render: (row) => <span className="inline-flex items-center rounded-md border border-border bg-surface-card px-2 py-1 text-xs font-medium text-foreground">{roleLabel(row)}</span>,
    },
    {
      key: "access",
      header: "Access",
      render: (row) => {
        const ids = scopedApis(row);
        if (ids.length === 0) return <span className="text-xs text-text-secondary">All APIs</span>;
        return <div className="flex flex-wrap gap-1">
          {ids.slice(0, 2).map((id) => <Badge key={id} variant="neutral" className="font-mono">{id}</Badge>)}
          {ids.length > 2 ? <Badge variant="outline">+{ids.length - 2}</Badge> : null}
        </div>;
      },
    },
    { key: "status", header: "Status", render: (row) => <StatusPill status={row.status ?? "active"} map={GRANT_STATUS_MAP} /> },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (row) => <ActionMenu
        label={`Actions for grant to ${row.userId}`}
        items={[
          { icon: Copy, label: "Copy user ID", onSelect: () => copy(row.userId, "User ID") },
          { separator: true },
          { icon: Trash2, label: "Revoke", destructive: true, onSelect: () => setRevokeTarget(row) },
        ]}
      />,
    },
  ];

  return <MainScreenWrapper>
    <ScreenHeader
      title="Team & Access"
      description="Grant product roles to teammates. Everyone else inherits access from their Geiger team role."
      actions={grantButton}
    />

    <StatsBar stats={stats} />

    <Toolbar>
      <div className="flex flex-wrap items-center gap-2">
        <FilterDropdown label="Role" value={roleFilter} onValueChange={setRoleFilter} options={roleOptions} height="h-9" />
        <FilterDropdown label="Access" value={accessFilter} onValueChange={setAccessFilter} options={ACCESS_FILTER_OPTIONS} height="h-9" />
      </div>
      <SearchInput value={search} onChange={setSearch} placeholder="Search user IDs, roles, APIs…" />
    </Toolbar>

    {state.status === "loading" ? <LoadingArea panel label="Loading role grants" /> : null}
    {state.status === "error" ? <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={ShieldCheck}
      title="Grants unavailable"
      description={state.error}
      action={<Button variant="outline" onClick={() => { setState({ status: "loading", items: [], error: null }); refresh(); }}>Retry</Button>}
    /></div> : null}
    {state.status === "ready" ? <div className="space-y-5">
      <DataTable
        columns={columns}
        data={pager.pageItems}
        getRowKey={(row) => row.id}
        empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
          icon={ShieldCheck}
          title={grants.length ? "No grants match your filters" : "No product grants yet"}
          description={grants.length
            ? "Try clearing the search or filters."
            : "Everyone here inherits access from the Geiger team. Grant a product role to narrow or extend it."}
          action={grants.length ? null : grantButton}
        /></div>}
      />
      <ListPagination {...pager} itemLabel="grants" />
    </div> : null}

    <GrantRoleDialog
      key={granting ? "grant-open" : "grant-closed"}
      open={granting}
      onOpenChange={setGranting}
      onSubmit={grant}
      busy={busy}
    />

    <Dialog open={!!revokeTarget} onOpenChange={(open) => { if (!open) setRevokeTarget(null); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Revoke role</DialogTitle>
          <DialogDescription>
            Revoke <span className="font-medium text-foreground">{revokeTarget ? roleLabel(revokeTarget) : ""}</span> from <span className="font-mono text-xs text-foreground">{revokeTarget?.userId}</span>? They fall back to their inherited Geiger access immediately.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setRevokeTarget(null)}>Cancel</Button>
          <Button className="bg-red-500/90 text-white hover:bg-red-500" disabled={busy} onClick={revoke}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Revoke
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </MainScreenWrapper>;
}
