"use client";

import { Copy, Eye, ShieldCheck, UserPlus, UserRound } from "lucide-react";
import { DataTable, EmptyState, SearchInput, StatusPill, Toolbar } from "@/components/internal/shared/screen_kit";
import { ListPagination, usePagination } from "@/components/internal/shared/pagination";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Badge } from "@geiger/ui/badge";
import FilterDropdown from "../../overview/filter_dropdown";
import { GRANT_STATUS_MAP, accessLabel, copy, formatDate, roleLabel } from "./team_model";

export function MemberCell({ userId, subtitle }) {
  return <div className="flex min-w-0 items-center gap-3">
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-card text-muted-foreground">
      <UserRound className="h-4 w-4" />
    </div>
    <div className="min-w-0">
      <p className="truncate font-mono text-xs font-medium text-foreground">{userId}</p>
      {subtitle ? <p className="truncate text-xs text-text-secondary">{subtitle}</p> : null}
    </div>
  </div>;
}

export function RoleChip({ children }) {
  return <span className="inline-flex items-center rounded-md border border-border bg-surface-card px-2 py-1 text-xs font-medium text-foreground">{children}</span>;
}

export function MembersTab({ members, total, search, setSearch, roleFilter, setRoleFilter, roleOptions, onOpen, onGrant, emptyAction }) {
  const pager = usePagination(members, { resetKey: `${search}|${roleFilter}` });

  const columns = [
    {
      key: "member",
      header: "Member",
      render: (row) => <MemberCell userId={row.userId} subtitle={`${row.grants.length} grant${row.grants.length === 1 ? "" : "s"}`} />,
    },
    {
      key: "roles",
      header: "Roles",
      render: (row) => <div className="flex flex-wrap gap-1">
        {row.grants.slice(0, 2).map((grant) => <RoleChip key={grant.id}>{roleLabel(grant)}</RoleChip>)}
        {row.grants.length > 2 ? <Badge variant="outline">+{row.grants.length - 2}</Badge> : null}
      </div>,
    },
    { key: "access", header: "Access", render: (row) => <span className="text-xs text-text-secondary">{accessLabel(row.apis)}</span> },
    { key: "status", header: "Status", render: (row) => <StatusPill status={row.status} map={GRANT_STATUS_MAP} /> },
    { key: "since", header: "Since", render: (row) => <span className="text-xs text-text-secondary">{formatDate(row.since)}</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (row) => <ActionMenu
        label={`Actions for ${row.userId}`}
        items={[
          { icon: Eye, label: "View grants", onSelect: () => onOpen(row) },
          { icon: UserPlus, label: "Grant another role", onSelect: () => onGrant(row.userId) },
          { separator: true },
          { icon: Copy, label: "Copy user ID", onSelect: () => copy(row.userId, "User ID") },
        ]}
      />,
    },
  ];

  return <div className="space-y-4">
    <Toolbar>
      <FilterDropdown label="Role" value={roleFilter} onValueChange={setRoleFilter} options={roleOptions} height="h-9" />
      <SearchInput value={search} onChange={setSearch} placeholder="Search user IDs, roles…" />
    </Toolbar>
    <DataTable
      columns={columns}
      data={pager.pageItems}
      getRowKey={(row) => row.userId}
      onRowClick={onOpen}
      empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
        icon={ShieldCheck}
        title={total ? "No members match your filters" : "No one holds a product role yet"}
        description={total
          ? "Try clearing the search or the role filter."
          : "Everyone here inherits access from the Geiger team. Grant a product role to narrow or extend it."}
        action={total ? null : emptyAction}
      /></div>}
    />
    <ListPagination {...pager} itemLabel="members" />
  </div>;
}
