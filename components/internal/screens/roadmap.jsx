"use client";

import { ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Badge } from "@geiger/ui/badge";
import { phases } from "@/lib/workspace/roadmap";

export function Roadmap() {
  return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
    <ScreenHeader title="Gateway roadmap" description="From the Geiger workspace to a complete API gateway, one verified milestone at a time." />
    <SectionCard title="Implementation milestones" description="Only the workspace foundation is available today." bodyPadding={false}>
      <ol className="divide-y divide-border">{phases.map((phase) => <li key={phase.number} className="flex gap-4 p-5"><span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-card font-mono text-xs text-muted-foreground">{String(phase.number).padStart(2, "0")}</span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">{phase.title}</h2><Badge variant={phase.status ? "secondary" : "outline"}>{phase.status || "Planned"}</Badge></div><p className="mt-1 text-sm leading-6 text-muted-foreground">{phase.detail}</p></div></li>)}</ol>
    </SectionCard>
  </div>;
}
