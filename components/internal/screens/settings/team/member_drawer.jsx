"use client";

import { Copy, Trash2, UserPlus } from "lucide-react";
import { StatusPill } from "@/components/internal/shared/screen_kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@geiger/ui/sheet";
import { GRANT_STATUS_MAP, accessLabel, copy, formatDate, roleLabel, scopedApis } from "./team_model";

// Everything one member holds: their grants, each revocable, plus a shortcut to
// grant them another role.
export function MemberDrawer({ member, onOpenChange, onGrant, onRevoke }) {
  if (!member) return null;
  return <Sheet open onOpenChange={onOpenChange}>
    <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
      <SheetHeader className="shrink-0 gap-3 border-b border-border p-5 pr-12">
        <div className="flex min-w-0 items-center gap-2">
          <SheetTitle className="truncate font-mono text-sm">{member.userId}</SheetTitle>
          <StatusPill status={member.status} map={GRANT_STATUS_MAP} />
        </div>
        <SheetDescription>
          {member.grants.length} product role{member.grants.length === 1 ? "" : "s"} · {accessLabel(member.apis)} · since {formatDate(member.since)}
        </SheetDescription>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => copy(member.userId, "User ID")}>
            <Copy className="h-3.5 w-3.5" /> Copy user ID
          </Button>
          <span className="flex-1" />
          <Button size="sm" className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => onGrant(member.userId)}>
            <UserPlus className="h-3.5 w-3.5" /> Grant another role
          </Button>
        </div>
      </SheetHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 z-10 border-b border-border bg-surface-card px-5 py-2">
          <span className="text-[11px] font-medium uppercase tracking-wider text-text-tertiary">Grants</span>
        </div>
        <ul className="divide-y divide-border px-5">
          {member.grants.map((grant) => {
            const ids = scopedApis(grant);
            return <li key={grant.id} className="flex items-start justify-between gap-4 py-3">
              <div className="min-w-0 space-y-1">
                <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                  {roleLabel(grant)}
                  <StatusPill status={grant.status ?? "active"} map={GRANT_STATUS_MAP} />
                </p>
                {ids.length ? <div className="flex flex-wrap gap-1">
                  {ids.map((id) => <Badge key={id} variant="neutral" className="font-mono">{id}</Badge>)}
                </div> : <p className="text-xs text-text-secondary">All APIs</p>}
                <p className="text-xs text-text-tertiary">Granted {formatDate(grant.createdAt)}</p>
              </div>
              {grant.status !== "revoked" ? <Button
                variant="outline"
                size="sm"
                aria-label={`Revoke ${roleLabel(grant)}`}
                className="shrink-0 text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                onClick={() => onRevoke(grant)}
              >
                <Trash2 className="h-3.5 w-3.5" /> Revoke
              </Button> : null}
            </li>;
          })}
        </ul>
      </div>
    </SheetContent>
  </Sheet>;
}
