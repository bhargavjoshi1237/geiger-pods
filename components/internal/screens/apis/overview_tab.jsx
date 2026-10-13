"use client";

import { toast } from "sonner";
import { ArrowRight, Copy, Globe, Layers, Network, Rocket, Route, Server, ShieldCheck, Waypoints } from "lucide-react";
import { SectionCard, StatGrid } from "@/components/internal/shared/screen_kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";

const PROTOCOL_LABEL = { REST: "REST", HTTP: "HTTP", WEBSOCKET: "WebSocket" };

function GlanceRow({ icon: Icon, label, value }) {
  return <div className="flex items-center gap-3 text-sm">
    <Icon className="size-4 shrink-0 text-text-secondary" />
    <span className="w-40 shrink-0 text-text-secondary">{label}</span>
    <span className="min-w-0 truncate text-foreground">{value}</span>
  </div>;
}

function copy(value, what) {
  navigator.clipboard?.writeText(value).then(
    () => toast.success(`${what} copied.`),
    () => toast.error(`Couldn't copy the ${what.toLowerCase()}.`),
  );
}

function StageRow({ stage }) {
  return <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface-card px-4 py-3">
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <span className="font-medium text-foreground">{stage.name}</span>
        {stage.autoDeploy ? <Badge variant="outline">Auto-deploy</Badge> : null}
        {stage.canary ? <Badge variant="outline">Canary</Badge> : null}
      </div>
      <p className="mt-0.5 truncate font-mono text-xs text-text-secondary">{stage.invokeUrl ?? "No invoke URL yet"}</p>
    </div>
    {stage.invokeUrl ? <Button
      variant="ghost"
      size="icon-sm"
      aria-label={`Copy ${stage.name} invoke URL`}
      className="text-text-secondary hover:bg-surface-active hover:text-foreground"
      onClick={() => copy(stage.invokeUrl, "Invoke URL")}
    ><Copy className="size-4" /></Button> : null}
  </div>;
}

export function OverviewTab({ api, stages = [], onNavigate }) {
  const deployed = stages.filter((stage) => stage.deploymentId).length;
  const buildTab = api.protocol === "REST" ? "resources" : "routes";

  const stats = [
    { label: "Protocol", value: PROTOCOL_LABEL[api.protocol] ?? api.protocol, icon: Network, hint: `${api.endpointType} endpoint` },
    { label: "Stages", value: String(stages.length), icon: Layers, hint: stages.length ? `${deployed} serving a deployment` : "None yet" },
    { label: "Default endpoint", value: api.disableDefaultEndpoint ? "Off" : "On", icon: Globe, hint: api.disableDefaultEndpoint ? "Custom domains only" : "Reachable directly" },
    { label: "Version", value: api.apiVersion || "—", icon: Waypoints, hint: "Version label" },
  ];

  return <div className="space-y-8">
    <StatGrid stats={stats} />

    <SectionCard
      bare
      title="At a glance"
      action={<Button
        size="sm"
        variant="outline"
        className="border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground"
        onClick={() => copy(api.publicId, "API ID")}
      ><Copy className="size-4" />Copy API ID</Button>}
    >
      <div className="space-y-2.5">
        <GlanceRow icon={Server} label="API ID" value={<span className="font-mono">{api.publicId}</span>} />
        <GlanceRow icon={Globe} label="IP address type" value={api.ipAddressType === "dualstack" ? "Dual-stack (IPv4 + IPv6)" : "IPv4 only"} />
        <GlanceRow icon={ShieldCheck} label="Missing route" value={api.missingRouteBehavior === "not_found" ? "404 Not Found" : "403 Missing Authentication Token"} />
        <GlanceRow icon={Route} label="Description" value={api.description || "No description"} />
      </div>
    </SectionCard>

    <SectionCard
      bare
      title="Stages"
      description="Named environments serving an immutable deployment."
      action={onNavigate ? <Button
        size="sm"
        variant="outline"
        className="border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground"
        onClick={() => onNavigate("stages")}
      >Manage<ArrowRight className="size-4" /></Button> : null}
    >
      {stages.length ? <div className="space-y-2">{stages.map((stage) => <StageRow key={stage.id} stage={stage} />)}</div> : <button
        type="button"
        onClick={() => onNavigate?.("deployments")}
        className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-surface-card py-10 text-text-secondary transition-colors hover:border-border-strong hover:text-muted-foreground"
      >
        <Rocket className="size-6" />
        <p className="text-sm">Nothing deployed yet — create a deployment to put this API on a stage</p>
      </button>}
    </SectionCard>

    {onNavigate ? <SectionCard bare title="Next steps" description="Where to go to build this API out.">
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { tab: buildTab, title: api.protocol === "REST" ? "Resources" : "Routes", text: api.protocol === "REST" ? "Model paths and methods." : "Define route keys." },
          { tab: "integrations", title: "Integrations", text: "Connect each route to a backend." },
          { tab: "deployments", title: "Deploy", text: "Snapshot the draft onto a stage." },
        ].map((step) => <button
          key={step.tab}
          type="button"
          onClick={() => onNavigate(step.tab)}
          className="group rounded-xl border border-border bg-surface-card p-4 text-left transition-colors hover:bg-surface-subtle"
        >
          <span className="flex items-center justify-between text-sm font-medium text-foreground">
            {step.title}
            <ArrowRight className="size-4 text-text-secondary transition-transform group-hover:translate-x-0.5" />
          </span>
          <span className="mt-1 block text-xs text-text-secondary">{step.text}</span>
        </button>)}
      </div>
    </SectionCard> : null}
  </div>;
}
