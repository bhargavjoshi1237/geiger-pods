"use client";

import { useCallback, useEffect, useState } from "react";
import { Globe, Network, Plus, Radio, Upload, Zap } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";

const PROTOCOLS = [
  {
    value: "REST",
    title: "REST",
    summary: "Full-featured APIs with resources, methods, models and usage plans.",
    icon: Globe,
  },
  {
    value: "HTTP",
    title: "HTTP",
    summary: "Low-latency APIs with simple routes, JWT authorizers and auto-deploy.",
    icon: Zap,
  },
  {
    value: "WEBSOCKET",
    title: "WebSocket",
    summary: "Persistent two-way connections with $connect, $disconnect and custom routes.",
    icon: Radio,
  },
];

export async function fetchApis(projectId, path = "", options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/apis${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

function CreateApiDialog({ open, onOpenChange, onCreated }) {
  const { project } = useProject();
  const [protocol, setProtocol] = useState("REST");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const body = { name: name.trim(), description: description.trim() || undefined, protocol };
      if (protocol === "HTTP" && target.trim()) body.quickCreate = { target: target.trim() };
      const created = await fetchApis(project.id, "", { method: "POST", body: JSON.stringify(body) });
      toast.success(`Created ${created.name}.`);
      if (created.quickCreatePending) toast.warning(created.quickCreatePending);
      onOpenChange(false);
      setName("");
      setDescription("");
      setTarget("");
      await onCreated();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>New API</DialogTitle>
        <DialogDescription>Pick a protocol. Names are unique per project.</DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={submit}>
        <div className="grid gap-2">
          {PROTOCOLS.map((entry) => {
            const Icon = entry.icon;
            const selected = protocol === entry.value;
            return <button
              key={entry.value}
              type="button"
              onClick={() => setProtocol(entry.value)}
              className={`flex items-start gap-3 rounded-lg border p-3 text-left ${selected ? "border-primary" : "border-border"}`}
              aria-pressed={selected}
            >
              <Icon className="mt-0.5 size-4 shrink-0" />
              <span>
                <span className="block text-sm font-medium">{entry.title}</span>
                <span className="block text-xs text-muted-foreground">{entry.summary}</span>
              </span>
            </button>;
          })}
        </div>
        <div className="space-y-2">
          <Label htmlFor="api-name">Name</Label>
          <Input id="api-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="pets-api" required maxLength={128} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="api-description">Description (optional)</Label>
          <Textarea id="api-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={2} maxLength={1024} />
        </div>
        {protocol === "HTTP" ? <div className="space-y-2">
          <Label htmlFor="api-target">Backend URL (optional, HTTP quick-create)</Label>
          <Input id="api-target" value={target} onChange={(event) => setTarget(event.target.value)} placeholder="https://api.example.com" inputMode="url" />
          <p className="text-xs text-muted-foreground">Creates a $default route now; the proxy integration and stage arrive with S04/S05.</p>
        </div> : null}
        <DialogFooter>
          <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create API"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function ApiListScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [creating, setCreating] = useState(false);
  const writable = can("pods.api.create");

  const refresh = useCallback(async () => {
    setState({ status: "loading", items: [], error: null });
    try {
      const data = await fetchApis(project.id, "");
      setState({ status: "ready", items: data.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [project.id]);

  useEffect(() => {
    let alive = true;
    fetchApis(project.id, "").then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id]);

  return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
    <ScreenHeader
      title="APIs"
      description="REST, HTTP and WebSocket APIs. Routes and resources are the draft; stages serve immutable deployments."
      actions={<div className="flex gap-2">
        <Button variant="outline" disabled title="Import OpenAPI arrives in S13"><Upload className="size-4" />Import OpenAPI</Button>
        {writable ? <Button onClick={() => setCreating(true)}><Plus className="size-4" />New API</Button> : null}
      </div>}
    />
    {state.status === "loading" ? <SectionCard><div className="flex justify-center py-10"><LogoLoading /></div></SectionCard> : null}
    {state.status === "error" ? <SectionCard><EmptyState icon={Network} title="APIs unavailable" description={state.error} action={<Button variant="outline" onClick={refresh}>Retry</Button>} /></SectionCard> : null}
    {state.status === "ready" && state.items.length === 0 ? <SectionCard><EmptyState
      icon={Network}
      title="No APIs yet"
      description="REST APIs model resources and methods. HTTP APIs use simple routes. WebSocket APIs stay connected. Create your first API to begin."
      action={writable ? <Button onClick={() => setCreating(true)}>New API</Button> : null}
    /></SectionCard> : null}
    {state.status === "ready" && state.items.length > 0 ? <SectionCard title="APIs" description={`${state.items.length} API${state.items.length === 1 ? "" : "s"}.`}>
      <ul className="divide-y divide-border">
        {state.items.map((api) => <li key={api.id} className="flex flex-wrap items-center gap-3 py-4 first:pt-0 last:pb-0">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              <a className="underline-offset-4 hover:underline" href={`./apis/${encodeURIComponent(api.publicId ?? api.id)}`}>{api.name}</a>
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">{api.protocol}</Badge>
              <span>{api.endpointType}</span>
              <span className="font-mono">{api.publicId}</span>
              <span>stages —</span>
            </p>
          </div>
          <Button variant="outline" size="sm" asChild><a href={`./apis/${encodeURIComponent(api.publicId ?? api.id)}`}>Open</a></Button>
        </li>)}
      </ul>
    </SectionCard> : null}
    {writable ? <CreateApiDialog open={creating} onOpenChange={setCreating} onCreated={refresh} /> : null}
  </div>;
}
