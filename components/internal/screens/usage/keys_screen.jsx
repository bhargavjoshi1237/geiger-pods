"use client";

// API keys screen (S08 §7): list (name, prefix, enabled, customer, last
// used); create (auto/custom value) with the one-time value display; reveal
// (permission-gated, audited); enable/disable; rotate; import CSV with a
// preview and warnings; delete. Key values only ever appear once or through
// the gated reveal — the list and detail views carry metadata only.

import { useCallback, useEffect, useState } from "react";
import { Copy, Eye, KeyRound, Plus, RotateCw, Upload } from "lucide-react";
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
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/api-keys${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

function ValueOnce({ value, title }) {
  return <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
    <p className="text-sm font-medium">{title}</p>
    <div className="flex items-center gap-2">
      <Input readOnly value={value} spellCheck={false} onFocus={(event) => event.target.select()} />
      <Button variant="outline" size="sm" onClick={() => {
        navigator.clipboard?.writeText(value).then(
          () => toast.success("Key value copied."),
          () => toast.error("Copy failed."),
        );
      }}><Copy className="size-4" />Copy</Button>
    </div>
  </div>;
}

export function ApiKeysScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", value: "", description: "", customerId: "" });
  const [fresh, setFresh] = useState(null);
  const [revealed, setRevealed] = useState(null);
  const [detail, setDetail] = useState(null);
  const [importing, setImporting] = useState(false);
  const [csv, setCsv] = useState("Name,Key,Description,Enabled,UsagePlanIds\n");
  const [busy, setBusy] = useState(false);
  const writable = can("pods.api_key.write");
  const revealable = can("pods.api_key.reveal");

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

  const create = async () => {
    if (!form.name.trim()) {
      toast.error("Name is required.");
      return;
    }
    setBusy(true);
    try {
      const created = await api(project.id, "", {
        method: "POST",
        body: JSON.stringify({
          name: form.name.trim(),
          ...(form.value ? { value: form.value } : {}),
          ...(form.description ? { description: form.description } : {}),
          ...(form.customerId ? { customerId: form.customerId } : {}),
        }),
      });
      setFresh(created);
      setCreating(false);
      setForm({ name: "", value: "", description: "", customerId: "" });
      toast.success("API key created.");
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const reveal = async (key) => {
    setBusy(true);
    try {
      const data = await api(project.id, `/${encodeURIComponent(key.id)}?includeValue=true`);
      setRevealed(data);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (key) => {
    setBusy(true);
    try {
      await api(project.id, `/${encodeURIComponent(key.id)}`, {
        method: "PATCH",
        headers: { "If-Match": String(key.version) },
        body: JSON.stringify({ enabled: !key.enabled }),
      });
      toast.success(key.enabled ? "Key disabled — runtime blocks it within a minute." : "Key enabled.");
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const rotate = async (key) => {
    setBusy(true);
    try {
      const rotated = await api(project.id, `/${encodeURIComponent(key.id)}/rotate`, { method: "POST", body: "{}" });
      setFresh(rotated);
      toast.success("Key rotated — the old key stays enabled until you disable it.");
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (key) => {
    setBusy(true);
    try {
      await api(project.id, `/${encodeURIComponent(key.id)}`, { method: "DELETE" });
      toast.success("Key deleted.");
      setDetail(null);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const importCsv = async (failOnWarnings) => {
    setBusy(true);
    try {
      const result = await api(project.id, "/import", {
        method: "POST",
        body: JSON.stringify({ csv, failOnWarnings }),
      });
      toast.success(`Imported ${result.ids.length} key(s).`);
      if ((result.warnings ?? []).length > 0) {
        toast.warning(`${result.warnings.length} warning(s) — see the import dialog.`);
      }
      setImporting(false);
      await refresh();
      return result;
    } catch (error) {
      toast.error(error.message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const openDetail = async (key) => {
    try {
      const data = await api(project.id, `/${encodeURIComponent(key.id)}`);
      setDetail(data);
    } catch (error) {
      toast.error(error.message);
    }
  };

  return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
    <ScreenHeader
      title="API keys"
      description="Client identifiers for usage plans. Keys identify callers — they do not authenticate them."
      action={<span className="flex gap-2">
        <Button variant="outline" size="sm" asChild><a href="usage-plans">Usage plans</a></Button>
        {writable ? <Button size="sm" onClick={() => setCreating(true)}><Plus className="size-4" />Create key</Button> : null}
      </span>}
    />
    {fresh ? <ValueOnce value={fresh.value} title="Copy this value now — it is shown once and never stored in readable form." /> : null}
    {revealed ? <ValueOnce value={revealed.value} title={`Revealed value for ${revealed.name} (audited).`} /> : null}
    {state.status === "loading" ? <SectionCard><div className="flex justify-center py-10"><LogoLoading /></div></SectionCard> : null}
    {state.status === "error" ? <SectionCard><EmptyState icon={KeyRound} title="Keys unavailable" description={state.error} action={<Button variant="outline" onClick={refresh}>Retry</Button>} /></SectionCard> : null}
    {state.status === "ready" && state.items.length === 0 ? <SectionCard><EmptyState icon={KeyRound} title="No API keys yet" description="Create a key, then attach it to a usage plan to let it call an API stage." /></SectionCard> : null}
    {state.status === "ready" && state.items.length > 0 ? <SectionCard title="Keys">
      <ul className="divide-y divide-border">
        {state.items.map((key) => <li key={key.id} className="flex flex-wrap items-center gap-2 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{key.name} <code className="text-xs text-muted-foreground">…{key.prefix}</code></p>
            <p className="text-xs text-muted-foreground">{key.customerId ? `Customer ${key.customerId} · ` : ""}{key.lastUsedAt ? `Last used ${key.lastUsedAt}` : "Never used"}</p>
          </div>
          {key.enabled ? <Badge variant="outline">enabled</Badge> : <Badge variant="secondary">disabled</Badge>}
          <Button variant="outline" size="sm" onClick={() => openDetail(key)}>Details</Button>
          {revealable ? <Button variant="outline" size="sm" disabled={busy} onClick={() => reveal(key)}><Eye className="size-4" />Reveal</Button> : null}
          {writable ? <Button variant="outline" size="sm" disabled={busy} onClick={() => toggle(key)}>{key.enabled ? "Disable" : "Enable"}</Button> : null}
          {writable ? <Button variant="outline" size="sm" disabled={busy} onClick={() => rotate(key)}><RotateCw className="size-4" />Rotate</Button> : null}
        </li>)}
      </ul>
      {writable ? <div className="pt-3"><Button variant="outline" size="sm" onClick={() => setImporting(true)}><Upload className="size-4" />Import CSV</Button></div> : null}
    </SectionCard> : null}
    {detail ? <SectionCard title={detail.name} description={`Prefix …${detail.prefix}`}>
      <p className="text-xs text-muted-foreground">Plans: {(detail.plans ?? []).length === 0 ? "none" : detail.plans.map((plan) => plan.name).join(", ")}</p>
      <div className="flex gap-2 pt-3">
        {writable ? <Button variant="outline" size="sm" disabled={busy} onClick={() => remove(detail)}>Delete</Button> : null}
        <Button variant="ghost" size="sm" onClick={() => setDetail(null)}>Close</Button>
      </div>
    </SectionCard> : null}

    <Dialog open={creating} onOpenChange={setCreating}>
      <DialogContent>
        <DialogHeader><DialogTitle>Create API key</DialogTitle>
          <DialogDescription>Generated values are 40 random characters. Custom values must be 20–128 characters of letters, digits, dash or underscore.</DialogDescription></DialogHeader>
        <div className="space-y-3">
          <div><Label htmlFor="key-name">Name</Label><Input id="key-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></div>
          <div><Label htmlFor="key-value">Custom value (optional)</Label><Input id="key-value" value={form.value} onChange={(event) => setForm({ ...form, value: event.target.value })} placeholder="Leave empty to generate" /></div>
          <div><Label htmlFor="key-desc">Description</Label><Input id="key-desc" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></div>
          <div><Label htmlFor="key-customer">Customer ID</Label><Input id="key-customer" value={form.customerId} onChange={(event) => setForm({ ...form, customerId: event.target.value })} /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
          <Button disabled={busy} onClick={create}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={importing} onOpenChange={setImporting}>
      <DialogContent>
        <DialogHeader><DialogTitle>Import keys (AWS format)</DialogTitle>
          <DialogDescription>Header Name,Key,Description,Enabled,UsagePlanIds. Bad rows become warnings and are skipped.</DialogDescription></DialogHeader>
        <Label htmlFor="key-csv">CSV</Label>
        <Textarea id="key-csv" className="min-h-32 font-mono text-xs" value={csv} onChange={(event) => setCsv(event.target.value)} spellCheck={false} />
        <DialogFooter>
          <Button variant="ghost" onClick={() => setImporting(false)}>Cancel</Button>
          <Button variant="outline" disabled={busy} onClick={() => importCsv(false)}>Import</Button>
          <Button disabled={busy} onClick={() => importCsv(true)}>Import (fail on warnings)</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
