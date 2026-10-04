"use client";

import { ArrowRight, CheckCircle2, Folder, Network, ShieldCheck, UserRound } from "lucide-react";
import { ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { useProject } from "@/context/project-context";
import { useSession } from "@/context/session-context";
import { WorkspaceLink } from "@/context/workspace-nav-context";

export function PodsOverview() {
  const { project } = useProject();
  const { user } = useSession();
  return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
    <ScreenHeader title="Overview" description={`Your gateway workspace for ${project.name}.`} actions={<Button asChild variant="outline"><WorkspaceLink section="roadmap">View roadmap<ArrowRight className="size-4" /></WorkspaceLink></Button>} />
    <div className="grid gap-4 sm:grid-cols-3">
      {[{ Icon: Folder, label: "Project", value: project.name, hint: "Shared across Geiger" }, { Icon: UserRound, label: "Session", value: "Connected", hint: user.email }, { Icon: ShieldCheck, label: "Your access", value: project.inheritedRole, hint: "Inherited from your Geiger team" }].map(({ Icon, label, value, hint }) => (
        <SectionCard key={label}><div className="flex items-center justify-between text-text-secondary"><span className="text-[11px] font-medium uppercase tracking-wider">{label}</span><Icon className="size-4" /></div><p className="mt-3 truncate text-xl font-semibold capitalize">{value}</p><p className="mt-1 truncate text-xs text-muted-foreground">{hint}</p></SectionCard>
      ))}
    </div>
    <SectionCard title="Your workspace is ready" description="The foundation is in place. Your APIs will live in this project." action={<Badge variant="outline">Phase 0</Badge>}>
      <div className="grid gap-8 md:grid-cols-[1.2fr_1fr]">
        <div className="space-y-4">
          {["Use your existing Geiger account", "Use your shared Geiger project", "Keep your team’s access together"].map((item) => <div key={item} className="flex items-center gap-3 text-sm"><CheckCircle2 className="size-4 shrink-0 text-muted-foreground" /><span>{item}</span></div>)}
          <Button asChild variant="outline" className="mt-2"><WorkspaceLink section="settings">View project details<ArrowRight className="size-4" /></WorkspaceLink></Button>
        </div>
        <div className="rounded-lg border border-border bg-surface-card p-5"><Network className="mb-3 size-5 text-muted-foreground" /><h2 className="font-semibold">Next: your API catalog</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">Create API definitions, connect services and configure routes. Publishing and traffic monitoring follow in later milestones.</p><Button asChild variant="link" className="mt-2 px-0"><WorkspaceLink section="apis">Explore the next milestone<ArrowRight className="size-4" /></WorkspaceLink></Button></div>
      </div>
    </SectionCard>
    <SectionCard title="Gateway activity" description="Traffic appears here once an API is published."><div className="flex min-h-40 flex-col items-center justify-center gap-2 text-center"><span className="text-sm font-medium">No gateway traffic yet</span><p className="max-w-md text-sm text-muted-foreground">API publishing is an upcoming milestone. This workspace does not serve requests yet.</p></div></SectionCard>
  </div>;
}
