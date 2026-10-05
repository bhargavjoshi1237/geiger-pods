"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";

async function call(projectId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

/**
 * API keys screen (S08 §7): list (name, prefix, enabled, last used,
 * customer id); create (auto/custom value) with the one-time value display;
 * reveal (permission-gated, audited); enable/disable; rotate; CSV import
 * with warnings; delete. Keys identify clients; they do not authenticate
 * them (shown as a notice, AWS parity).
 */
export function ApiKeysScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [form, setForm] = useState({ name: "", value: "", customerId: "" });
  const [created, setCreated] = useState(null);
  const [revealed, setRevealed] = useState({});
  const [busy, setBusy] = useState(false);
  const [csv, setCsv] = useState("");

  const refresh = useCallback(async () => {
    setState({ status: "loading", items: [], error: null });
    try {
      const data = await call(project.id, "/api-keys");
      setState({ status: "ready", items: data.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [project.id]);

  useEffect(() => {
    let alive = true;
    call(project.id, "/api-keys").then(
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
      const data = await call(project.id, "/api-keys", {
        method: "POST",
        body: JSON.stringify({
          name: form.name.trim(),
          value: form.value.trim() === "" ? undefined : form.value.trim(),
          customerId: form.customerId.trim() === "" ? null : form.customerId.trim(),
        }),
      });
      setCreated(data);
      setForm({ name: "", value: "", customerId: "" });
      toast.success("API key created. Copy the value now — it is shown once.");
      refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const reveal = async (key) => {
    try {
      const data = await call(project.id, `/api-keys/${encodeURIComponent(key.id)}?includeValue=true`);
      setRevealed((prev) => ({ ...prev, [key.id]: data.value }));
    } catch (error) {
      toast.error(error.message);
    }
  };

  const setEnabled = async (key, enabled) => {
    try {
      await call(project.id, `/api-keys/${encodeURIComponent(key.id)}`, {
        method: "PATCH",
        headers: { "If-Match": String(key.version) },
        body: JSON.stringify({ enabled }),
      });
      toast.success(enabled ? "Key enabled." : "Key disabled. Runtimes apply this within a minute.");
      refresh();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const rotate = async (key) => {
    setBusy(true);
    try {
      const data = await call(project.id, `/api-keys/${encodeURIComponent(key.id)}/rotate`, { method: "POST", body: "{}" });
      setCreated(data);
      toast.success("Rotated. The old key stays enabled until you disable it.");
      refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (key) => {
    try {
      await call(project.id, `/api-keys/${encodeURIComponent(key.id)}`, { method: "DELETE" });
      toast.success("Key deleted.");
      refresh();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const importCsv = async (failOnWarnings) => {
    if (!csv.trim()) {
      toast.error("Paste CSV first (Name,Key,Description,Enabled,UsagePlanIds).");
      return;
    }
    setBusy(true);
    try {
      const data = await call(project.id, "/api-keys/import", {
        method: "POST",
        body: JSON.stringify({ csv, failOnWarnings }),
      });
      toast.success(`Imported ${data.ids.length} key(s).`);
      if ((data.warnings ?? []).length > 0) toast.warning(data.warnings[0]);
      setCsv("");
      refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <div className="space-y-4">
    <ScreenHeader
      title="API keys"
      description="API keys identify clients; they do not authenticate them. Throttles and quotas are best-effort across instances."
    />
    {created?.value ? <SectionCard title="Copy this value now" description="It is shown once and never again.">
      <code className="block truncate rounded bg-muted p-2 font-mono text-sm">{created.value}</code>
      <div className="mt-2"><Button variant="outline" size="sm" onClick={() => setCreated(null)}>Dismiss</Button></div>
    </SectionCard> : null}
    <SectionCard title="Create key" description="Leave the value blank to generate a 40-character key.">
      <div className="grid gap-2">
        <Label htmlFor="s08-key-name">Name</Label>
        <Input id="s08-key-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="mobile-app" />
        <Label htmlFor="s08-key-value">Custom value (optional, 20–128 chars of A–Z a–z 0–9 _ -)</Label>
        <Input id="s08-key-value" value={form.value} onChange={(event) => setForm({ ...form, value: event.target.value })} placeholder="auto-generate" />
        <Label htmlFor="s08-key-customer">Customer id (optional)</Label>
        <Input id="s08-key-customer" value={form.customerId} onChange={(event) => setForm({ ...form, customerId: event.target.value })} />
        <div><Button size="sm" disabled={busy || !can("pods.api_key.write")} onClick={create}>Create key</Button></div>
      </div>
    </SectionCard>
    <SectionCard title="Import CSV" description="AWS format: Name,Key,Description,Enabled,UsagePlanIds.">
      <textarea
        className="min-h-24 w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
        value={csv}
        onChange={(event) => setCsv(event.target.value)}
        spellCheck={false}
        placeholder={"Name,Key,Description,Enabled,UsagePlanIds"}
      />
      <div className="mt-2 flex gap-2">
        <Button variant="outline" size="sm" disabled={busy || !can("pods.api_key.write")} onClick={() => importCsv(false)}>Import</Button>
        <Button variant="outline" size="sm" disabled={busy || !can("pods.api_key.write")} onClick={() => importCsv(true)}>Import (fail on warnings)</Button>
      </div>
    </SectionCard>
    {state.status === "loading" ? <SectionCard><div className="flex justify-center py-10"><LogoLoading /></div></SectionCard> : null}
    {state.status === "error" ? <SectionCard><EmptyState icon={KeyRound} title="Keys unavailable" description={state.error} action={<Button variant="outline" onClick={refresh}>Retry</Button>} /></SectionCard> : null}
    {state.status === "ready" && state.items.length === 0 ? <SectionCard><EmptyState icon={KeyRound} title="No API keys yet" description="Create the first key above. Keys take effect without a redeploy." /></SectionCard> : null}
    {state.status === "ready" && state.items.length > 0 ? <SectionCard title="Keys">
      <ul className="space-y-3">
        {state.items.map((key) => <li key={key.id} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{key.name}</span>
          <code className="text-xs text-muted-foreground">{key.valuePrefix}…</code>
          {key.enabled ? <Badge>enabled</Badge> : <Badge variant="outline">disabled</Badge>}
          {key.customerId ? <span className="text-xs text-muted-foreground">{key.customerId}</span> : null}
          {revealed[key.id] ? <code className="font-mono text-xs">{revealed[key.id]}</code> : null}
          <span className="flex gap-1">
            {can("pods.api_key.reveal") ? <Button variant="outline" size="sm" onClick={() => reveal(key)}>Reveal</Button> : null}
            <Button variant="outline" size="sm" disabled={!can("pods.api_key.write")} onClick={() => setEnabled(key, !key.enabled)}>{key.enabled ? "Disable" : "Enable"}</Button>
            <Button variant="outline" size="sm" disabled={busy || !can("pods.api_key.write")} onClick={() => rotate(key)}>Rotate</Button>
            <Button variant="ghost" size="sm" disabled={!can("pods.api_key.write")} onClick={() => remove(key)}>Delete</Button>
          </span>
        </li>)}
      </ul>
    </SectionCard> : null}
  </div>;
}
