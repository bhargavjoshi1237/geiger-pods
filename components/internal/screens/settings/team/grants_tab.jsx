"use client";

import { Copy, ShieldCheck, Trash2 } from "lucide-react";
import { DataTable, EmptyState, SearchInput, StatusPill, Toolbar } from "@/components/internal/shared/screen_kit";
import { ListPagination, usePagination } from "@/components/internal/shared/pagination";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Badge } from "@geiger/ui/badge";
import FilterDropdown from "../../overview/filter_dropdown";
import { ACCESS_FILTER_OPTIONS, GRANT_STATUS_MAP, copy, formatDate, roleLabel, scopedApis } from "./team_model";
import { MemberCell, RoleChip } from "./members_tab";

export function GrantsTab({ grants, total, search, setSearch, roleFilter, setRoleFilter, roleOptions, accessFilter, setAccessFilter, onRevoke, emptyAction }) {
  const pager = usePagination(grants, { resetKey: `${search}|${roleFilter}|${accessFilter}` });

  const columns = [
    { key: "member", header: "Member", render: (row) => <MemberCell userId={row.userId} subtitle={`Granted ${formatDate(row.createdAt)}`} /> },
    { key: "role", header: "Role", render: (row) => <RoleChip>{roleLabel(row)}</RoleChip> },
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
          { icon: Trash2, label: "Revoke", destructive: true, onSelect: () => onRevoke(row) },
        ]}
      />,
    },
  ];

  return <div className="space-y-4">
    <Toolbar>
      <div className="flex flex-wrap items-center gap-2">
        <FilterDropdown label="Role" value={roleFilter} onValueChange={setRoleFilter} options={roleOptions} height="h-9" />
        <FilterDropdown label="Access" value={accessFilter} onValueChange={setAccessFilter} options={ACCESS_FILTER_OPTIONS} height="h-9" />
      </div>
      <SearchInput value={search} onChange={setSearch} placeholder="Search user IDs, roles, APIs…" />
    </Toolbar>
    <DataTable
      columns={columns}
      data={pager.pageItems}
      getRowKey={(row) => row.id}
      empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
        icon={ShieldCheck}
        title={total ? "No grants match your filters" : "No product grants yet"}
        description={total
          ? "Try clearing the search or filters."
          : "Everyone here inherits access from the Geiger team. Grant a product role to narrow or extend it."}
        action={total ? null : emptyAction}
      /></div>}
    />
    <ListPagination {...pager} itemLabel="grants" />
  </div>;
}
