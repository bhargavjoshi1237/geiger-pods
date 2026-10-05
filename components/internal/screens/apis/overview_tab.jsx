"use client";

import { SectionCard } from "@geiger/ui/screen-kit";

function Row({ label, children }) {
  return <div className="flex flex-wrap gap-2 py-2 text-sm first:pt-0 last:pb-0">
    <dt className="w-44 shrink-0 text-muted-foreground">{label}</dt>
    <dd className="min-w-0 flex-1 break-words">{children}</dd>
  </div>;
}

export function OverviewTab({ api }) {
  return <div className="space-y-8">
    <SectionCard title="API overview" description="Identity and endpoint settings. Stages and deployments arrive in S05.">
      <dl className="divide-y divide-border">
        <Row label="Public ID"><span className="font-mono">{api.publicId}</span></Row>
        <Row label="Description">{api.description || "—"}</Row>
        <Row label="Protocol">{api.protocol}</Row>
        <Row label="Version label">{api.apiVersion || "—"}</Row>
        <Row label="Endpoint type">{api.endpointType}</Row>
        <Row label="Default endpoint">{api.disableDefaultEndpoint ? "Disabled" : "Enabled"}</Row>
        <Row label="Missing route behavior">{api.missingRouteBehavior === "not_found" ? "404 Not Found" : "403 Missing Authentication Token (AWS default)"}</Row>
      </dl>
    </SectionCard>
    <SectionCard title="Deployments" description="Immutable snapshots served by stages.">
      <p className="text-sm text-muted-foreground">No deployments yet. Deployments and stages arrive in S05.</p>
    </SectionCard>
  </div>;
}
