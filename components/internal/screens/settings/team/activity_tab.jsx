"use client";

import { Clock, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { EmptyState, LoadingArea, SectionCard } from "@/components/internal/shared/screen_kit";
import { Button } from "@geiger/ui/button";
import { cn } from "@geiger/ui/lib/utils";
import { formatRelativeTime } from "./team_model";

// Role grant history, read from the audit log (resource type `role_grant`).
const ACTION_MAP = {
  "role.grant": { label: "granted", icon: UserPlus, tone: "text-emerald-600 dark:text-emerald-400" },
  "role.revoke": { label: "revoked a grant from", icon: Trash2, tone: "text-red-600 dark:text-red-400" },
};

const short = (id) => (id && id.length > 12 ? `${id.slice(0, 8)}…` : id);

function Sentence({ entry }) {
  const after = entry.after ?? {};
  const before = entry.before ?? {};
  const actor = entry.actor_id ?? entry.actorId;
  const meta = ACTION_MAP[entry.action] ?? { label: entry.action };
  const target = after.userId ?? before.userId ?? entry.resource_id ?? entry.resourceId;
  return <p className="text-sm text-foreground">
    <span className="font-mono text-xs font-medium" title={actor}>{actor ? short(actor) : "Someone"}</span>{" "}
    <span className="text-text-secondary">{meta.label}</span>{" "}
    {entry.action === "role.grant" && after.roleKey ? <><span className="font-medium">{after.roleKey}</span> <span className="text-text-secondary">to</span>{" "}</> : null}
    <span className="font-mono text-xs font-medium" title={target}>{short(target) ?? ""}</span>
    {after.scope?.api?.length ? <span className="text-text-secondary"> on {after.scope.api.length} API{after.scope.api.length === 1 ? "" : "s"}</span> : null}
  </p>;
}

export function ActivityTab({ state, onRetry }) {
  if (state.status === "loading") return <LoadingArea panel label="Loading activity" />;
  if (state.status === "error") {
    return <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={ShieldCheck}
      title="Activity unavailable"
      description={state.error}
      action={<Button variant="outline" onClick={onRetry}>Retry</Button>}
    /></div>;
  }
  if (!state.items.length) {
    return <SectionCard>
      <EmptyState icon={Clock} title="No activity yet" description="Role grants and revocations will show up here." />
    </SectionCard>;
  }
  return <SectionCard bodyPadding={false} contentClassName="p-4">
    <ol className="space-y-4">
      {state.items.map((entry) => {
        const meta = ACTION_MAP[entry.action] ?? { icon: Clock, tone: "text-text-secondary" };
        const Icon = meta.icon;
        return <li key={entry.id} className="flex gap-3">
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-surface-card">
            <Icon className={cn("h-3.5 w-3.5", meta.tone)} />
          </div>
          <div className="min-w-0">
            <Sentence entry={entry} />
            <p className="text-xs text-text-tertiary">{formatRelativeTime(entry.created_at ?? entry.createdAt)}</p>
          </div>
        </li>;
      })}
    </ol>
  </SectionCard>;
}
