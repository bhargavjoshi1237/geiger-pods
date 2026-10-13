"use client";

import { ScreenHeader, SectionCard, StatsBar, StatusPill } from "@/components/internal/shared/screen_kit";
import { MainScreenWrapper } from "@/components/internal/shared/screen_wrappers";
import { phases } from "@/lib/workspace/roadmap";

const PHASE_STATUS_MAP = {
  Available: { label: "Available", variant: "success" },
  "In progress": { label: "In progress", variant: "info" },
  Planned: { label: "Planned", variant: "neutral" },
};

export function Roadmap() {
  const available = phases.filter((phase) => phase.status === "Available").length;
  const stats = [
    { label: "Milestones", value: String(phases.length), footer: "From foundation to production" },
    { label: "Available", value: String(available), footer: "Ready to use today" },
    { label: "Planned", value: String(phases.length - available), footer: "Still to come" },
  ];
  return <MainScreenWrapper>
    <ScreenHeader title="Roadmap" description="From the Geiger workspace to a complete API gateway, one verified milestone at a time." />
    <StatsBar stats={stats} columns={3} />
    <SectionCard title="Milestones" description="Each milestone ships once it has been verified end to end." bodyPadding={false}>
      <ol className="divide-y divide-border">
        {phases.map((phase) => <li key={phase.number} className="flex gap-4 px-5 py-4">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-card font-mono text-xs text-muted-foreground">{String(phase.number).padStart(2, "0")}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-medium text-foreground">{phase.title}</h2>
              <StatusPill status={phase.status || "Planned"} map={PHASE_STATUS_MAP} />
            </div>
            <p className="mt-1 text-sm text-text-secondary">{phase.detail}</p>
          </div>
        </li>)}
      </ol>
    </SectionCard>
  </MainScreenWrapper>;
}
