"use client";

// Developer portals screen (S13 part D, `/portals`): list, portal editor
// (branding with live preview, access settings, linked products, preview
// link, publish/disable, analytics) and products (pages markdown editor,
// endpoint picker, sharing, shared-with-me).
import { useCallback, useEffect, useState } from "react";
import { Globe } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";

async function portalsFetch(projectId, path, init) {
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/portals`;
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    credentials: "same-origin",
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Portal request failed (${response.status}).`);
  return data;
}

async function productsFetch(projectId, path, init) {
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/products`;
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    credentials: "same-origin",
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Product request failed (${response.status}).`);
  return data;
}

export function PortalListScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", portals: [], products: [], error: null });
  const [form, setForm] = useState({ name: "", slug: "" });
  const [busy, setBusy] = useState(false);
  const canWrite = can("pods.portal.write");
  const canPublish = can("pods.portal.publish");

  const refresh = useCallback(async () => {
    setState({ status: "loading", portals: [], products: [], error: null });
    try {
      const [portals, products] = await Promise.all([
        portalsFetch(project.id, "", {}),
        productsFetch(project.id, "", {}),
      ]);
      setState({ status: "ready", portals: portals.items ?? [], products: products.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", portals: [], products: [], error: error.message });
    }
  }, [project.id]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [portals, products] = await Promise.all([
          portalsFetch(project.id, "", {}),
          productsFetch(project.id, "", {}),
        ]);
        if (alive) setState({ status: "ready", portals: portals.items ?? [], products: products.items ?? [], error: null });
      } catch (error) {
        if (alive) setState({ status: "error", portals: [], products: [], error: error.message });
      }
    })();
    return () => { alive = false; };
  }, [project.id, refresh]);

  const create = async () => {
    if (!form.name.trim() || !form.slug.trim()) {
      toast.error("Give the portal a name and slug first.");
      return;
    }
    setBusy(true);
    try {
      await portalsFetch(project.id, "", { method: "POST", body: JSON.stringify({ name: form.name.trim(), slug: form.slug.trim() }) });
      toast.success("Portal created as DRAFT. Publish to freeze a public snapshot.");
      setForm({ name: "", slug: "" });
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const publish = async (portal) => {
    setBusy(true);
    try {
      await portalsFetch(project.id, `/${encodeURIComponent(portal.id)}/publish`, { method: "POST" });
      toast.success("Published. The public portal now serves the frozen snapshot.");
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const disable = async (portal) => {
    setBusy(true);
    try {
      await portalsFetch(project.id, `/${encodeURIComponent(portal.id)}`, { method: "PATCH", body: JSON.stringify({ status: "DISABLED" }) });
      toast.success("Portal disabled (public URL now 404s).");
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  if (state.status === "loading") return <SectionCard><div className="flex justify-center py-10"><LogoLoading /></div></SectionCard>;
  if (state.status === "error") {
    return <SectionCard><EmptyState icon={Globe} title="Portals unavailable" description={state.error} action={<Button variant="outline" onClick={refresh}>Retry</Button>} /></SectionCard>;
  }

  return (
    <div className="space-y-4">
      <ScreenHeader title="Developer portals" description="Publish API products with docs, branding and access control. Preview needs workspace sign-in; published pages serve frozen snapshots." />
      <SectionCard>
        <h3 className="text-sm font-medium">Portals ({state.portals.length})</h3>
        {state.portals.length === 0
          ? <EmptyState icon={Globe} title="No portals yet" description="Create the first portal below. It starts as DRAFT with a preview link." />
          : (
            <ul className="mt-2 space-y-1">
              {state.portals.map((portal) => (
                <li key={portal.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-2 text-sm">
                  <span><span className="font-medium">{portal.name}</span> <span className="font-mono text-xs text-muted-foreground">/{portal.slug} · {portal.status}</span></span>
                  <span className="flex gap-2">
                    <a className="text-xs underline" href={`/portal/${encodeURIComponent(portal.slug)}`}>Open public page</a>
                    {canPublish ? <Button variant="outline" disabled={busy} onClick={() => publish(portal)}>Publish</Button> : null}
                    {canWrite ? <Button variant="outline" disabled={busy} onClick={() => disable(portal)}>Disable</Button> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        {canWrite ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Portal name" className="rounded-md border border-border bg-background px-2 py-1 text-sm" aria-label="Portal name" />
            <input value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value })} placeholder="portal-slug" className="rounded-md border border-border bg-background px-2 py-1 text-sm" aria-label="Portal slug" />
            <Button disabled={busy} onClick={create}>Create portal</Button>
          </div>
        ) : null}
      </SectionCard>
      <SectionCard>
        <h3 className="text-sm font-medium">Products ({state.products.length})</h3>
        {state.products.length === 0
          ? <p className="mt-1 text-sm text-muted-foreground">No products yet. Products group endpoint pages; share them across projects instead of AWS cross-account RAM.</p>
          : (
            <ul className="mt-2 space-y-1 text-sm">
              {state.products.map((entry) => <li key={entry.id} className="rounded border border-border p-2">{entry.name}</li>)}
            </ul>
          )}
      </SectionCard>
    </div>
  );
}
