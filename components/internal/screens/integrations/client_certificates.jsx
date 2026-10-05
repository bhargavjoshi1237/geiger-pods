"use client";

// Backend client certificates (S04 §6, REST). Standalone card: the
// orchestrator mounts it under API settings. Generate shows the public PEM
// for backend trust stores; rotation is create → switch stage → delete.

import { useCallback, useEffect, useState } from "react";
import { Download, KeyRound, Plus } from "lucide-react";
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
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/client-certificates${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

function withExpiry(items) {
  const now = Date.now();
  return (items ?? []).map((certificate) => ({
    ...certificate,
    expired: new Date(certificate.expiresAt).getTime() < now,
  }));
}

export function ClientCertificatesCard() {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const writable = can("pods.client_cert.write");
  // Expiry is stamped when data arrives (effects below), never during render.
  const items = state.items ?? [];

  const refresh = useCallback(async () => {
    setState({ status: "loading", items: [], error: null });
    try {
      const data = await api(project.id, "");
      setState({ status: "ready", items: withExpiry(data.items ?? []), error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [project.id]);

  useEffect(() => {
    let alive = true;
    api(project.id, "").then(
      (data) => { if (alive) setState({ status: "ready", items: withExpiry(data.items ?? []), error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id]);

  const mutate = async (work, success) => {
    setBusy(true);
    try {
      await work();
      toast.success(success);
      await refresh();
    } catch (mutationError) {
      toast.error(mutationError.message);
    } finally {
      setBusy(false);
    }
  };

  const download = (certificate) => {
    const blob = new Blob([certificate.certificatePem], { type: "application/x-pem-file" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `pods-client-cert-${certificate.publicId}.pem`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (!writable) {
    return <SectionCard><EmptyState icon={KeyRound} title="Access unavailable" description="Your current team access does not allow this screen." /></SectionCard>;
  }

  return <div className="space-y-8">
    <ScreenHeader
      title="Backend client certificates"
      description="Gateway identity for mTLS to backends. Trust the PEM on your backend, then select the certificate on the stage."
      actions={<Button onClick={() => setCreating(true)}><Plus className="size-4" />Generate certificate</Button>}
    />
    {state.status === "loading" ? <SectionCard><div className="flex justify-center py-10"><LogoLoading /></div></SectionCard> : null}
    {state.status === "error" ? <SectionCard><EmptyState icon={KeyRound} title="Certificates unavailable" description={state.error} action={<Button variant="outline" onClick={refresh}>Retry</Button>} /></SectionCard> : null}
    {state.status === "ready" && items.length === 0 ? <SectionCard><EmptyState icon={KeyRound} title="No client certificates" description="Generate one and trust its PEM on your backend." action={<Button onClick={() => setCreating(true)}>Generate certificate</Button>} /></SectionCard> : null}
    {state.status === "ready" && items.length > 0 ? <SectionCard title="Certificates" description="Rotate by generating a replacement, switching the stage, then deleting the old one.">
      <ul className="divide-y divide-border">
        {items.map((certificate) => {
          const expired = certificate.expired;
          return <li key={certificate.id} className="flex flex-wrap items-center gap-3 py-4 first:pt-0 last:pb-0">
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-sm">{certificate.publicId}</p>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {expired ? <Badge variant="destructive">expired</Badge> : <Badge variant="outline">valid</Badge>}
                <span>expires {new Date(certificate.expiresAt).toLocaleDateString()}</span>
                {certificate.description ? <span>{certificate.description}</span> : null}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => download(certificate)}><Download className="size-4" />PEM</Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => mutate(
                  () => api(project.id, `/${encodeURIComponent(certificate.id)}`, { method: "DELETE" }),
                  "Certificate deleted.",
                )}
              >Delete</Button>
            </div>
          </li>;
        })}
      </ul>
    </SectionCard> : null}
    <Dialog open={creating} onOpenChange={setCreating}>
      <DialogContent>
        <DialogHeader><DialogTitle>Generate certificate</DialogTitle><DialogDescription>RSA-2048, self-signed, valid 365 days. The private key is sealed in the vault.</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          void mutate(
            () => api(project.id, "", {
              method: "POST",
              body: JSON.stringify({ description: String(form.get("description") ?? "") || undefined }),
            }),
            "Certificate generated.",
          ).then(() => setCreating(false));
        }}>
          <div className="space-y-2">
            <Label htmlFor="cert-description">Description (optional)</Label>
            <Input id="cert-description" name="description" placeholder="Production backend identity" />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy}>{busy ? "Generating…" : "Generate"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>;
}
