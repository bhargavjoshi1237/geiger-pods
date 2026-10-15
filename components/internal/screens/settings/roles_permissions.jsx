"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { Check, Lock, Search, ShieldCheck, SlidersHorizontal, Users } from "lucide-react";
import { matchesAny } from "@geiger/rbac";
import { DataTable, EmptyState, LoadingArea, ScreenHeader, SearchInput, StatsBar, Toolbar } from "@/components/internal/shared/screen_kit";
import { MainScreenWrapper } from "@/components/internal/shared/screen_wrappers";
import { Notice, ScreenTabs } from "@/components/internal/shared/settings_screen";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@geiger/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@geiger/ui/table";
import { cn } from "@geiger/ui/lib/utils";
import rbacConfig from "@/geiger-rbac.config";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { useRecordParam } from "@/lib/hooks/use-record-param";
import FilterDropdown from "../overview/filter_dropdown";
import { api } from "./team/team_model";

// Settings → Roles & Permissions, after geiger-events' screen of the same name:
// a Roles list, a role × permission matrix, and a drawer for one role. Read-only
// here — Pods grants roles (Team & Access) but never writes them: the system
// roles live in geiger-rbac.config.js and project roles in the suite-shared
// public.roles table, seeded by an admin job.

const PERMISSIONS = rbacConfig.permissions;
const ALL_KEYS = PERMISSIONS.map((permission) => permission.key);
const SYSTEM_KEYS = new Set(rbacConfig.systemRoles.map((role) => role.key));

const PERMISSION_GROUPS = (() => {
  const groups = new Map();
  for (const permission of PERMISSIONS) {
    if (!groups.has(permission.group)) groups.set(permission.group, []);
    groups.get(permission.group).push(permission);
  }
  return [...groups].map(([group, permissions]) => ({ group, permissions }));
})();

const TABS_BASE = [
  { key: "roles", label: "Roles" },
  { key: "matrix", label: "Permission matrix", count: ALL_KEYS.length },
];

const TYPE_FILTER_OPTIONS = [
  { value: "all", label: "All Types" },
  { value: "system", label: "System" },
  { value: "custom", label: "Custom" },
];

const GROUP_FILTER_OPTIONS = [
  { value: "all", label: "All Groups" },
  ...PERMISSION_GROUPS.map(({ group }) => ({ value: group, label: group })),
];

const isOwnerRole = (role) => (role?.permissions ?? []).includes("*");
const grantsKey = (role, key) => matchesAny(role?.permissions ?? [], key);
const grantedCount = (role) => ALL_KEYS.filter((key) => grantsKey(role, key)).length;

/**
 * Code-defined system roles first, then the project's own roles. A project row
 * sharing a system key replaces it: that row is what a grant actually uses.
 */
function mergeRoles(projectRoles) {
  const byKey = new Map(rbacConfig.systemRoles.map((role) => [role.key, {
    id: `system:${role.key}`, key: role.key, name: role.name, description: role.description, permissions: role.permissions, isSystem: true,
  }]));
  for (const role of projectRoles) {
    const system = role.key ? byKey.get(role.key) : null;
    byKey.set(role.key ?? role.id, {
      ...role,
      description: role.description || system?.description || "",
      isSystem: role.isSystem || SYSTEM_KEYS.has(role.key),
    });
  }
  return [...byKey.values()];
}

function filterGroups(query, group = "all") {
  const q = query.trim().toLowerCase();
  return PERMISSION_GROUPS.filter((entry) => group === "all" || entry.group === group)
    .map((entry) => ({
      group: entry.group,
      permissions: q ? entry.permissions.filter((p) => p.label.toLowerCase().includes(q) || p.key.toLowerCase().includes(q)) : entry.permissions,
    }))
    .filter((entry) => entry.permissions.length);
}

function TypeBadge({ role }) {
  return <Badge variant={role.isSystem ? "neutral" : "info"}>{role.isSystem ? "System" : "Custom"}</Badge>;
}

function ScopeTag({ permission }) {
  if (!permission.scopeBy) return null;
  return <span className="shrink-0 rounded border border-border bg-surface-card px-1 py-px text-[10px] text-text-tertiary">per {permission.scopeBy}</span>;
}

// How much of the catalog a role reaches.
function CoverageBar({ role, className }) {
  const owner = isOwnerRole(role);
  const total = ALL_KEYS.length;
  const granted = owner ? total : grantedCount(role);
  const pct = total ? Math.round((granted / total) * 100) : 0;
  return <div className={cn("w-[150px] space-y-1.5", className)}>
    <div className="h-1.5 overflow-hidden rounded-full bg-surface-hover">
      <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
    </div>
    <p className="text-xs text-text-secondary">{owner ? "Every permission" : `${granted} of ${total} · ${pct}%`}</p>
  </div>;
}

function PeopleCount({ count }) {
  if (count === null) return <span className="text-xs text-text-tertiary">—</span>;
  if (!count) return <span className="text-xs text-text-tertiary">Nobody</span>;
  return <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-text-secondary">
    <Users className="h-3.5 w-3.5" />{count} {count === 1 ? "person" : "people"}
  </span>;
}

function RolesTab({ roles, total, counts, search, setSearch, typeFilter, setTypeFilter, onOpen }) {
  const columns = [
    {
      key: "name",
      header: "Role",
      render: (role) => <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium text-foreground">{role.name}</span>
        <span className="line-clamp-1 text-xs text-text-secondary">{role.description || "No description"}</span>
      </div>,
    },
    { key: "type", header: "Type", render: (role) => <TypeBadge role={role} /> },
    { key: "key", header: "Key", render: (role) => <span className="font-mono text-xs text-text-secondary">{role.key ?? "—"}</span> },
    { key: "people", header: "People", render: (role) => <PeopleCount count={counts ? counts[role.key] ?? 0 : null} /> },
    { key: "coverage", header: "Access", render: (role) => <CoverageBar role={role} /> },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (role) => <ActionMenu
        label={`Actions for ${role.name}`}
        items={[{ icon: SlidersHorizontal, label: "View permissions", onSelect: () => onOpen(role) }]}
      />,
    },
  ];

  return <div className="space-y-4">
    <Toolbar>
      <FilterDropdown label="Type" value={typeFilter} onValueChange={setTypeFilter} options={TYPE_FILTER_OPTIONS} height="h-9" />
      <SearchInput value={search} onChange={setSearch} placeholder="Search roles…" />
    </Toolbar>
    <DataTable
      columns={columns}
      data={roles}
      getRowKey={(role) => role.id}
      onRowClick={onOpen}
      empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
        icon={ShieldCheck}
        title={total ? "No roles match your filters" : "No roles yet"}
        description={total ? "Try clearing the search or the type filter." : "Roles appear here once they are seeded for this project."}
      /></div>}
    />
  </div>;
}

// Every permission against every role at once — answers "who can promote a
// stage?" the way a stack of role drawers never could.
function MatrixTab({ roles, query, setQuery, groupFilter, setGroupFilter, onOpenRole }) {
  const groups = useMemo(() => filterGroups(query, groupFilter), [query, groupFilter]);

  return <div className="space-y-4">
    <Toolbar>
      <FilterDropdown label="Group" value={groupFilter} onValueChange={setGroupFilter} options={GROUP_FILTER_OPTIONS} height="h-9" />
      <SearchInput value={query} onChange={setQuery} placeholder="Search permissions…" />
    </Toolbar>

    {groups.length === 0 ? <div className="rounded-xl border border-border bg-surface-subtle">
      <EmptyState icon={Search} title="No matching permissions" description="Try a different search, or switch back to all groups." />
    </div> : <div className="overflow-hidden rounded-xl border border-border bg-surface-subtle">
      <Table>
        <TableHeader>
          <TableRow className="border-border hover:bg-transparent">
            <TableHead className="sticky left-0 z-20 min-w-[260px] bg-surface-subtle px-4">Permission</TableHead>
            {roles.map((role) => <TableHead key={role.id} className="w-[132px] px-3 text-center">
              <button type="button" onClick={() => onOpenRole(role)} className="mx-auto flex w-full max-w-[116px] flex-col items-center gap-1 normal-case hover:text-foreground">
                <span className="w-full truncate text-xs font-semibold tracking-normal text-foreground">{role.name}</span>
                <span className="text-[10px] font-medium tracking-normal text-text-tertiary tabular-nums">
                  {isOwnerRole(role) ? `all ${ALL_KEYS.length}` : `${grantedCount(role)}/${ALL_KEYS.length}`}
                </span>
              </button>
            </TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map(({ group, permissions }) => <Fragment key={group}>
            <TableRow className="border-border hover:bg-transparent">
              <TableCell colSpan={roles.length + 1} className="bg-surface-card px-4 py-2">
                {/* The cell spans the table, so the label itself pins. */}
                <span className="sticky left-4 inline-block text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                  {group}<span className="ml-2 normal-case tracking-normal text-text-tertiary/70">{permissions.length}</span>
                </span>
              </TableCell>
            </TableRow>
            {permissions.map((permission) => <TableRow key={permission.key} className="group border-border">
              <TableCell className="sticky left-0 z-10 bg-surface-subtle px-4 py-3 transition-colors group-hover:bg-surface-active">
                <span className="flex items-center gap-1.5">
                  <span className="text-sm text-foreground">{permission.label}</span>
                  <ScopeTag permission={permission} />
                </span>
                <span className="block font-mono text-[10px] text-text-tertiary">{permission.key}</span>
              </TableCell>
              {roles.map((role) => <TableCell key={role.id} className="px-3 py-3 text-center">
                <MatrixCell checked={grantsKey(role, permission.key)} label={`${permission.label} for ${role.name}`} />
              </TableCell>)}
            </TableRow>)}
          </Fragment>)}
        </TableBody>
      </Table>
    </div>}
  </div>;
}

function MatrixCell({ checked, label, className }) {
  return <span
    role="img"
    aria-label={`${label}: ${checked ? "granted" : "not granted"}`}
    className={cn(
      "mx-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md border",
      className,
      checked ? "border-primary/40 bg-primary/15 text-primary" : "border-border bg-surface-card text-transparent",
    )}
  >
    <Check className="h-3.5 w-3.5" />
  </span>;
}

function RoleDrawer({ role, count, query, setQuery, onOpenChange }) {
  const owner = isOwnerRole(role);
  const groups = useMemo(() => filterGroups(owner ? "" : query), [owner, query]);
  if (!role) return null;

  return <Sheet open onOpenChange={onOpenChange}>
    <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
      <SheetHeader className="shrink-0 gap-3 border-b border-border p-5 pr-12">
        <div className="flex min-w-0 items-center gap-2">
          <SheetTitle className="truncate text-lg">{role.name}</SheetTitle>
          <TypeBadge role={role} />
        </div>
        <SheetDescription>{role.description || "No description for this role."}</SheetDescription>
        <CoverageBar role={role} className="w-full" />
        <div className="flex flex-wrap items-center gap-2">
          {role.key ? <span className="rounded-md border border-border bg-surface-card px-2 py-1 font-mono text-xs text-text-secondary">{role.key}</span> : null}
          <span className="flex-1" />
          {count === null ? null : <PeopleCount count={count} />}
        </div>
      </SheetHeader>

      {owner ? <div className="shrink-0 border-b border-border p-4">
        <Notice icon={Lock}>Owner holds every permission — including ones added to Pods later — so a project always keeps a role that can administer it.</Notice>
      </div> : <div className="relative shrink-0 border-b border-border p-4">
        <Search className="pointer-events-none absolute left-7 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter permissions…" className="h-9 bg-surface-card pl-9 text-sm" />
      </div>}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 ? <p className="px-5 py-12 text-center text-sm text-text-tertiary">No permission matches “{query}”.</p> : groups.map(({ group, permissions }) => {
          const on = permissions.filter((permission) => grantsKey(role, permission.key)).length;
          return <section key={group}>
            <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-surface-card px-5 py-2">
              <span className="flex-1 truncate text-[11px] font-medium uppercase tracking-wider text-text-tertiary">{group}</span>
              <span className={cn("rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums", on ? "bg-primary/15 text-primary" : "text-text-tertiary")}>{on}/{permissions.length}</span>
            </div>
            <div className="divide-y divide-border px-5">
              {permissions.map((permission) => {
                const granted = grantsKey(role, permission.key);
                return <div key={permission.key} className="flex items-center justify-between gap-4 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className={cn("truncate text-sm", granted ? "text-foreground" : "text-text-tertiary")}>{permission.label}</span>
                      <ScopeTag permission={permission} />
                    </span>
                    <span className="block truncate font-mono text-[10px] text-text-tertiary">{permission.key}</span>
                  </span>
                  <MatrixCell checked={granted} label={permission.label} className="mx-0" />
                </div>;
              })}
            </div>
          </section>;
        })}
      </div>
    </SheetContent>
  </Sheet>;
}

export function RolesPermissionsScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [recordId, setRecordId] = useRecordParam();
  const [state, setState] = useState({ status: "loading", roles: [], hidden: 0, warning: null, attempt: 0 });
  const [counts, setCounts] = useState(null);
  const [tab, setTab] = useState("roles");
  const [roleSearch, setRoleSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [permQuery, setPermQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");
  const canSeeGrants = can("pods.role.grant");

  useEffect(() => {
    let alive = true;
    const settle = (projectRoles, warning) => {
      if (!alive) return;
      const merged = mergeRoles(projectRoles);
      // Roles reaching no Pods permission belong to other Geiger products.
      const roles = merged.filter((role) => isOwnerRole(role) || grantedCount(role) > 0);
      setState((current) => ({ ...current, status: "ready", roles, hidden: merged.length - roles.length, warning }));
    };
    // Without the project's roles the system roles are still known — show them.
    api(project.id, "/roles").then((data) => settle(data.items ?? [], null), (error) => settle([], error.message));
    return () => { alive = false; };
  }, [project.id, state.attempt]);

  useEffect(() => {
    if (!canSeeGrants) return undefined;
    let alive = true;
    api(project.id, "/role-grants").then(
      (data) => {
        if (!alive) return;
        const next = {};
        for (const grant of data.items ?? []) if (grant.roleKey && grant.status !== "revoked") next[grant.roleKey] = (next[grant.roleKey] ?? 0) + 1;
        setCounts(next);
      },
      () => { if (alive) setCounts(null); },
    );
    return () => { alive = false; };
  }, [project.id, canSeeGrants]);

  const { roles } = state;
  const openRole = recordId ? roles.find((role) => role.id === recordId) ?? null : null;

  const filteredRoles = useMemo(() => {
    const q = roleSearch.trim().toLowerCase();
    return roles.filter((role) => {
      if (typeFilter === "system" && !role.isSystem) return false;
      if (typeFilter === "custom" && role.isSystem) return false;
      return !q || `${role.name} ${role.key ?? ""} ${role.description ?? ""}`.toLowerCase().includes(q);
    });
  }, [roles, roleSearch, typeFilter]);

  const stats = useMemo(() => [
    { label: "Roles", value: String(roles.length), footer: "Grantable in this project" },
    { label: "System", value: String(roles.filter((role) => role.isSystem).length), footer: "Shipped with Pods" },
    { label: "Custom", value: String(roles.filter((role) => !role.isSystem).length), footer: "Seeded for this project" },
    { label: "Permissions", value: String(ALL_KEYS.length), footer: `Across ${PERMISSION_GROUPS.length} groups` },
  ], [roles]);

  const tabs = TABS_BASE.map((entry) => (entry.key === "roles" ? { ...entry, count: roles.length } : entry));

  return <MainScreenWrapper>
    <ScreenHeader title="Roles & Permissions" description="What each role can do across the workspace. Grant roles to teammates from Team & Access." />

    <StatsBar stats={stats} />

    <Notice icon={Lock}>
      Roles are read-only here: system roles ship with Pods and project roles are managed by your Geiger admin. Every key a role holds is checked again when it is granted.
      {state.hidden ? ` ${state.hidden} role${state.hidden === 1 ? "" : "s"} from other Geiger products ${state.hidden === 1 ? "is" : "are"} hidden.` : ""}
    </Notice>

    <ScreenTabs tabs={tabs} value={tab} onValueChange={setTab} />

    {state.status === "loading" ? <LoadingArea panel label="Loading roles" /> : null}
    {state.warning ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-700 dark:text-amber-300">
      <span>Showing system roles only — this project&apos;s roles couldn&apos;t be loaded: {state.warning}</span>
      <Button variant="outline" size="sm" onClick={() => setState((current) => ({ ...current, status: "loading", warning: null, attempt: current.attempt + 1 }))}>Retry</Button>
    </div> : null}
    {state.status === "ready" && tab === "roles" ? <RolesTab
      roles={filteredRoles}
      total={roles.length}
      counts={counts}
      search={roleSearch}
      setSearch={setRoleSearch}
      typeFilter={typeFilter}
      setTypeFilter={setTypeFilter}
      onOpen={(role) => setRecordId(role.id)}
    /> : null}
    {state.status === "ready" && tab === "matrix" ? <MatrixTab
      roles={roles}
      query={permQuery}
      setQuery={setPermQuery}
      groupFilter={groupFilter}
      setGroupFilter={setGroupFilter}
      onOpenRole={(role) => setRecordId(role.id)}
    /> : null}

    <RoleDrawer
      role={openRole}
      count={counts ? counts[openRole?.key] ?? 0 : null}
      query={permQuery}
      setQuery={setPermQuery}
      onOpenChange={(open) => { if (!open) setRecordId(null); }}
    />
  </MainScreenWrapper>;
}
