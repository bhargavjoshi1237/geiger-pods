"use client";

// Backend client certificates (REST). Standalone card: mounted under API
// settings. Generate shows the public PEM for backend trust stores; rotation
// is create → switch stage → delete.

import { useCallback, useEffect, useState } from "react";
import { Download, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { DataTable, EmptyState, Field, LoadingArea, SectionCard } from "@/components/internal/shared/screen_kit";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";

const PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";
const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

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
  const [description, setDescription] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
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
      return true;
    } catch (mutationError) {
      toast.error(mutationError.message);
      return false;
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

  const openCreate = () => {
    setDescription("");
    setCreating(true);
  };

  const title = "Backend client certificates";
  const blurb = "Gateway identity for mTLS to backends. Trust the PEM on your backend, then select the certificate on the stage.";

  if (!writable) {
    return <SectionCard bare title={title} description={blurb}>
      <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={KeyRound} title="Access unavailable" description="Your current team access does not allow managing client certificates." /></div>
    </SectionCard>;
  }

  const columns = [
    {
      key: "certificate",
      header: "Certificate",
      render: (certificate) => <div className="min-w-0">
        <p className="truncate font-mono text-sm font-medium text-foreground">{certificate.publicId}</p>
        {certificate.description ? <p className="mt-0.5 max-w-[26rem] truncate text-xs text-text-secondary">{certificate.description}</p> : null}
      </div>,
    },
    {
      key: "status",
      header: "Status",
      render: (certificate) => certificate.expired ? <Badge variant="destructive">Expired</Badge> : <Badge variant="outline">Valid</Badge>,
    },
    {
      key: "expires",
      header: "Expires",
      render: (certificate) => <span className="text-sm tabular-nums text-text-secondary">{new Date(certificate.expiresAt).toLocaleDateString()}</span>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (certificate) => <ActionMenu
        label={`Actions for ${certificate.publicId}`}
        disabled={busy}
        items={[
          { icon: Download, label: "Download PEM", onSelect: () => download(certificate) },
          { separator: true },
          { icon: Trash2, label: "Delete", destructive: true, onSelect: () => setDeleteTarget(certificate) },
        ]}
      />,
    },
  ];

  return <SectionCard
    bare
    title={title}
    description={blurb}
    action={<Button size="sm" className={PRIMARY} onClick={openCreate}><Plus className="size-4" />Generate Certificate</Button>}
  >
    {state.status === "loading" ? <LoadingArea panel label="Loading client certificates" /> : null}
    {state.status === "error" ? <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={KeyRound} title="Certificates unavailable" description={state.error} action={<Button variant="outline" className={SECONDARY} onClick={refresh}>Retry</Button>} /></div> : null}
    {state.status === "ready" ? <div className="space-y-3">
      <DataTable
        columns={columns}
        data={items}
        getRowKey={(certificate) => certificate.id}
        empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
          icon={KeyRound}
          title="No client certificates yet"
          description="Generate one and trust its PEM on your backend."
          action={<Button className={PRIMARY} onClick={openCreate}><Plus className="size-4" />Generate Certificate</Button>}
        /></div>}
      />
      {items.length > 0 ? <p className="text-xs text-text-secondary">Rotate by generating a replacement, switching the stage, then deleting the old one.</p> : null}
    </div> : null}

    <Dialog open={creating} onOpenChange={setCreating}>
      <DialogContent className="bg-background sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Generate Certificate</DialogTitle>
          <DialogDescription>RSA-2048, self-signed, valid 365 days. The private key is sealed in the vault.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(event) => {
          event.preventDefault();
          void mutate(
            () => api(project.id, "", {
              method: "POST",
              body: JSON.stringify({ description: description.trim() || undefined }),
            }),
            "Certificate generated.",
          ).then((ok) => { if (ok) setCreating(false); });
        }}>
          <Field label="Description" htmlFor="cert-description" hint="Optional.">
            <Input id="cert-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Production backend identity" autoFocus />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" className={SECONDARY} onClick={() => setCreating(false)}>Cancel</Button>
            <Button type="submit" className={PRIMARY} disabled={busy}>{busy ? <Loader2 className="size-4 animate-spin" /> : null}Generate Certificate</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !busy) setDeleteTarget(null); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete client certificate</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete <span className="font-mono font-medium text-foreground">{deleteTarget?.publicId}</span>? Stages that still use it can no longer present it to backends. This action can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button
            className="bg-red-500/90 text-white hover:bg-red-500"
            disabled={busy}
            onClick={() => {
              const certificate = deleteTarget;
              void mutate(
                () => api(project.id, `/${encodeURIComponent(certificate.id)}`, { method: "DELETE" }),
                "Certificate deleted.",
              ).then(() => setDeleteTarget(null));
            }}
          ><Trash2 className="size-4" />Delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </SectionCard>;
}
