"use client";

import { Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { SectionCard } from "@/components/internal/shared/screen_kit";
import { Button } from "@geiger/ui/button";
import { useProject } from "@/context/project-context";
import { dashHref } from "@/lib/workspace/model.mjs";

function copy(value) {
  navigator.clipboard?.writeText(value).then(
    () => toast.success("Copied."),
    () => toast.error("Couldn't copy to the clipboard."),
  );
}

// The shared Geiger project behind this workspace, as a section body. Settings ›
// General renders it as its "Project" section.
export function ProjectDetails() {
  const { project } = useProject();
  const fields = [
    { label: "Name", value: project.name },
    { label: "Slug", value: project.slug || "Not set", mono: Boolean(project.slug) },
    { label: "Project ID", value: project.id, mono: true, copyable: true },
    { label: "Organization ID", value: project.organizationId || "Personal project", mono: Boolean(project.organizationId), copyable: Boolean(project.organizationId) },
    { label: "Project status", value: project.status || "—" },
    { label: "Inherited role", value: project.inheritedRole || "—" },
  ];
  return <SectionCard
    title="Shared project"
    description="This project and its members are managed in Geiger Studio, and connect your work across the suite."
    action={<Button asChild variant="outline" size="sm" className="border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground">
      <a href={dashHref(project.organizationId ? `/org/${project.organizationId}` : "/org")}>Manage in Geiger<ExternalLink className="h-4 w-4" /></a>
    </Button>}
  >
    <dl className="grid gap-4 sm:grid-cols-2">
      {fields.map((field) => <div key={field.label} className="min-w-0">
        <dt className="text-xs text-text-secondary">{field.label}</dt>
        <dd className="mt-1 flex min-w-0 items-center gap-1 text-sm text-foreground">
          <span className={field.mono ? "break-all font-mono text-xs" : "break-words"}>{field.value}</span>
          {field.copyable ? <Button variant="ghost" size="icon-sm" aria-label={`Copy ${field.label}`} className="text-muted-foreground hover:bg-surface-active hover:text-foreground" onClick={() => copy(field.value)}>
            <Copy className="h-3.5 w-3.5" />
          </Button> : null}
        </dd>
      </div>)}
    </dl>
  </SectionCard>;
}
