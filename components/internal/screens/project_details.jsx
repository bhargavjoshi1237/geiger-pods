"use client";

import { ExternalLink } from "lucide-react";
import { ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
import { useProject } from "@/context/project-context";
import { dashHref } from "@/lib/workspace/model.mjs";

export function ProjectDetails() {
  const { project } = useProject();
  const fields = [["Name", project.name], ["Slug", project.slug || "Not set"], ["Project ID", project.id], ["Organization ID", project.organizationId || "Personal project"], ["Project status", project.status], ["Inherited role", project.inheritedRole]];
  return <div className="mx-auto w-full max-w-5xl space-y-6 px-2 py-4 lg:px-0">
    <ScreenHeader title="Project details" description="This project and its members are managed in Geiger Studio." actions={<Button asChild variant="outline"><a href={dashHref(project.organizationId ? `/org/${project.organizationId}` : "/org")}>Manage in Geiger<ExternalLink className="size-4" /></a></Button>} />
    <SectionCard title="Shared project" description="The same project connects your work across the Geiger suite.">
      <dl className="divide-y divide-border">{fields.map(([label, value]) => <div key={label} className="grid gap-2 py-4 first:pt-0 last:pb-0 sm:grid-cols-[180px_1fr]"><dt className="text-sm text-muted-foreground">{label}</dt><dd className="break-all text-sm font-medium">{value}</dd></div>)}</dl>
    </SectionCard>
  </div>;
}
