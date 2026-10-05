"use client";

// Export screen (S10 §9, `/settings/exports`): sink CRUD and test delivery.
// Secret material is never shown — configs carry vault refs only.

import { useCallback, useEffect, useState } from "react";
import { LockKeyhole, Plus, UploadCloud } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";

async function api(projectId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/log-sinks${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

export function ExportsScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const writable = can("pods.export.write");

  const refresh = useCallback(async () => {
    setState({ status: "loading", items: [], error: null });
    try {
      const data = await api(project.id, "");
      setState({ status: "ready", items: data.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [project.id]);

  useEffect(() => {
    let alive = true;
    api(project.id, "").then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id]);

  if (!can("pods.monitoring.view")) {
    return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
      <ScreenHeader title="Exports" description="Stream access logs to https endpoints or S3-compatible storage." />
      <SectionCard><EmptyState icon={LockKeyhole} title="Access unavailable" description="Your current team access does not allow this screen." /></SectionCard>
    </div>;
  }

  return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
    <ScreenHeader
      title="Exports"
      description="Firehose equivalent: https sinks get signed NDJSON batches; s3 sinks get gzipped objects."
      actions={writable ? <Button onClick={() => setCreating(true)}><Plus className="size-4" />New sink</Button> : null}
    />
    {state.status === "loading" ? <SectionCard><div className="flex justify-center py-10"><LogoLoading /></div></SectionCard> : null}
    {state.status === "error" ? <SectionCard><EmptyState icon={UploadCloud} title="Sinks unavailable" description={state.error} action={<Button variant="outline" onClick={refresh}>Retry</Button>} /></SectionCard> : null}
    {state.status === "ready" && state.items.length === 0 ? <SectionCard><EmptyState icon={UploadCloud} title="No sinks yet" description="Create one, then reference it from a stage's log destinations." action={writable ? <Button onClick={() => setCreating(true)}>New sink</Button> : undefined} /></SectionCard> : null}
    {state.status === "ready" && state.items.length > 0 ? <SectionCard title="Sinks" description={`${state.items.length} sink${state.items.length === 1 ? "" : "s"}.`}>
      <ul className="divide-y divide-border">
        {state.items.map((sink) => <li key={sink.id} className="flex flex-wrap items-center gap-3 py-4 first:pt-0 last:pb-0">
          <Badge variant={sink.status === "active" ? "outline" : "secondary"}>{sink.type} · {sink.status}</Badge>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{sink.name}</p>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              {sink.type === "https" ? sink.config.url : sink.type === "s3" ? `${sink.config.bucket ?? ""}/${sink.config.prefix ?? ""}` : sink.config.endpoint}
              {sink.lastDeliveryAt ? ` · delivered ${new Date(sink.lastDeliveryAt).toLocaleString()}` : " · never delivered"}
              {sink.lastError ? ` · ${sink.lastError}` : ""}
            </p>
          </div>
          <div className="flex gap-2">
            {writable && sink.type === "https" ? <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(project.id, `/${encodeURIComponent(sink.id)}/test`, { method: "POST" });
                  toast.success("Test batch delivered.");
                  await refresh();
                } catch (error) {
                  toast.error(error.message);
                  await refresh();
                } finally {
                  setBusy(false);
                }
              }}
            >Test delivery</Button> : null}
            {writable ? <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(project.id, `/${encodeURIComponent(sink.id)}`, { method: "DELETE" });
                  toast.success(`Deleted ${sink.name}.`);
                  await refresh();
                } catch (error) {
                  toast.error(error.message);
                } finally {
                  setBusy(false);
                }
              }}
            >Delete</Button> : null}
          </div>
        </li>)}
      </ul>
    </SectionCard> : null}
    <Dialog open={creating} onOpenChange={setCreating}>
      <DialogContent>
        <DialogHeader><DialogTitle>New sink</DialogTitle><DialogDescription>Credentials stay as vault secret refs — plaintext never appears here.</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const type = String(form.get("type") ?? "https");
          const config = type === "https"
            ? { url: String(form.get("url") ?? "").trim(), secretRef: String(form.get("secretRef") ?? "").trim() }
            : type === "s3"
              ? { bucket: String(form.get("bucket") ?? "").trim(), prefix: String(form.get("prefix") ?? "").trim(), credentialsRef: String(form.get("secretRef") ?? "").trim() }
              : { endpoint: String(form.get("url") ?? "").trim() };
          setBusy(true);
          api(project.id, "", {
            method: "POST",
            body: JSON.stringify({ name: String(form.get("name") ?? "").trim(), type, config }),
          }).then(
            () => {
              toast.success("Sink created.");
              setCreating(false);
              void refresh();
            },
            (error) => toast.error(error.message),
          ).finally(() => setBusy(false));
        }}>
          <div className="space-y-2"><Label htmlFor="sink-name">Name</Label><Input id="sink-name" name="name" required /></div>
          <div className="space-y-2"><Label htmlFor="sink-type">Type (https / s3 / otlp_logs)</Label><Input id="sink-type" name="type" defaultValue="https" required /></div>
          <div className="space-y-2"><Label htmlFor="sink-url">URL / endpoint (bucket for s3)</Label><Input id="sink-url" name="url" placeholder="https://logs.example.com/ingest" spellCheck={false} /></div>
          <div className="space-y-2"><Label htmlFor="sink-bucket">Bucket (s3 only)</Label><Input id="sink-bucket" name="bucket" spellCheck={false} /></div>
          <div className="space-y-2"><Label htmlFor="sink-prefix">Prefix (s3 only)</Label><Input id="sink-prefix" name="prefix" placeholder="pods-logs" spellCheck={false} /></div>
          <div className="space-y-2"><Label htmlFor="sink-secret">Secret ref (vault)</Label><Input id="sink-secret" name="secretRef" placeholder="secret:<id>@<version>" spellCheck={false} /></div>
          <DialogFooter><Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create sink"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>;
}
