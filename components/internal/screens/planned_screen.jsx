"use client";

import { ArrowRight } from "lucide-react";
import { ScreenHeader, EmptyState, SectionCard } from "@geiger/ui/screen-kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { WorkspaceLink } from "@/context/workspace-nav-context";
import { phases } from "@/lib/workspace/roadmap";

export function PlannedScreen({ item }) {
  const phase = phases.find((p) => p.number === item.phase);
  return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
    <ScreenHeader title={item.title} description={phase.detail} actions={<Badge variant="outline">Phase {phase.number} · Planned</Badge>} />
    <SectionCard><EmptyState icon={item.icon} title={`${item.title} is an upcoming milestone`} description="Your shared project workspace is ready. This feature will become available as the gateway is built." action={<Button asChild variant="outline"><WorkspaceLink section="roadmap">View implementation roadmap<ArrowRight className="size-4" /></WorkspaceLink></Button>} /></SectionCard>
  </div>;
}
