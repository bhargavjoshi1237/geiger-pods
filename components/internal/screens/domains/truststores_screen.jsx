"use client";

// Trust stores screen (S11 Part B): upload a PEM bundle, list certs with
// expiry, version history.

import { useCallback, useEffect, useState } from "react";
import { LockKeyhole, Plus, ShieldCheck } from "lucide-react";
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

async function api(projectId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/truststores${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

export function TruststoresScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [bundle, setBundle] = useState("");
  const projectId = project?.id;

  const load = useCallback(async () => {
    if (!projectId) return;
    setState({ status: "loading", items: [], error: null });
    try {
      const data = await api(projectId, "");
      setState({ status: "ready", items: data.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [projectId]);
  useEffect(() => {
    if (!projectId) return undefined;
    let alive = true;
    api(projectId, "").then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [projectId]);

  if (!can("pods.domains.view")) return <EmptyState icon={LockKeyhole} title="Access unavailable" description="Your current team access does not allow this screen." />;
  if (state.status === "loading") return <LogoLoading />;
  if (state.status === "error") return <EmptyState title="Could not load trust stores" description={state.error} />;

  return <div className="space-y-4">
    <ScreenHeader
      title="Trust stores"
      description="Client-CA bundles for mutual TLS, with expiry warnings and version history."
      action={<Button size="sm" onClick={() => setCreating(true)}><Plus className="size-4" />Upload bundle</Button>}
    />
    <div className="flex gap-2">
      <Button variant="outline" size="sm" asChild><a href="../">Custom domains</a></Button>
      <Button variant="outline" size="sm" asChild><a href="../../waf">Web application firewall</a></Button>
    </div>
    {state.items.length === 0 ? <EmptyState icon={ShieldCheck} title="No trust stores" description="Upload a PEM bundle to enable mTLS on a domain." /> : <SectionCard title="Trust stores">
      <ul className="space-y-2">
        {state.items.map((entry) => <li key={entry.id} className="rounded-md border p-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="font-medium">{entry.name}</span>
            <Badge variant="outline">v{entry.version}</Badge>
            <span className="text-xs text-muted-foreground">{entry.certCount} certs</span>
          </div>
          {(entry.warnings ?? []).length > 0 ? <ul className="mt-1 space-y-1 text-xs text-amber-600">
            {entry.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul> : null}
        </li>)}
      </ul>
    </SectionCard>}
    <Dialog open={creating} onOpenChange={setCreating}>
      <DialogContent>
        <DialogHeader><DialogTitle>Upload PEM bundle</DialogTitle><DialogDescription>Up to 1000 certificates, 1 MB. Public data.</DialogDescription></DialogHeader>
        <Label>Name</Label>
        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="client-ca" />
        <Label>PEM bundle</Label>
        <Textarea value={bundle} onChange={(event) => setBundle(event.target.value)} rows={8} spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" />
        <DialogFooter>
          <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
          <Button onClick={async () => {
            try {
              await api(projectId, "", { method: "POST", body: JSON.stringify({ name, pemBundle: bundle }) });
              toast.success("Trust store created.");
              setCreating(false);
              setName("");
              setBundle("");
              await load();
            } catch (error) {
              toast.error(error.message);
            }
          }}>Upload</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
