"use client";

// Usage plans screen (S08 §7): list; detail with tabs Settings (throttle,
// quota), Associated stages (add API + stage, per-method throttles table),
// API keys (add existing / remove) and Usage (date range, per-key daily
// used/remaining table, export CSV, extend/reset quota dialog).

import { useCallback, useEffect, useState } from "react";
import { CalendarRange, KeyRound, Plus } from "lucide-react";
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
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/usage-plans${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

async function apiKeys(projectId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/api-keys${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

const TABS = ["Settings", "Stages", "Keys", "Usage"];

export function UsagePlansScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", rate: "", burst: "", limit: "", period: "DAY", offset: "" });
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const writable = can("pods.usage_plan.write");

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const create = async () => {
    if (!form.name.trim()) {
      toast.error("Name is required.");
      return;
    }
    setBusy(true);
    try {
      const throttle = form.rate !== "" || form.burst !== ""
        ? { rateLimit: Number(form.rate || 0), burstLimit: Number(form.burst || 0) }
        : undefined;
      const quota = form.limit !== ""
        ? { limit: Number(form.limit), period: form.period, offset: Number(form.offset || 0) }
        : undefined;
      await api(project.id, "", {
        method: "POST",
        body: JSON.stringify({ name: form.name.trim(), description: form.description, throttle, quota }),
      });
      toast.success("Usage plan created.");
      setCreating(false);
      setForm({ name: "", description: "", rate: "", burst: "", limit: "", period: "DAY", offset: "" });
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (plan) => {
    setBusy(true);
    try {
      await api(project.id, `/${encodeURIComponent(plan.id)}`, { method: "DELETE" });
      toast.success("Usage plan deleted.");
      setSelected(null);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const openDetail = async (plan) => {
    try {
      const data = await api(project.id, `/${encodeURIComponent(plan.id)}`);
      setSelected({ ...data, tab: "Settings" });
    } catch (error) {
      toast.error(error.message);
    }
  };

  return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
    <ScreenHeader
      title="Usage plans"
      description="Throttle and quota envelopes for API stages and the keys that may call them."
      action={writable ? <Button size="sm" onClick={() => setCreating(true)}><Plus className="size-4" />Create plan</Button> : null}
    />
    {state.status === "loading" ? <SectionCard><div className="flex justify-center py-10"><LogoLoading /></div></SectionCard> : null}
    {state.status === "error" ? <SectionCard><EmptyState icon={KeyRound} title="Plans unavailable" description={state.error} action={<Button variant="outline" onClick={refresh}>Retry</Button>} /></SectionCard> : null}
    {state.status === "ready" && state.items.length === 0 ? <SectionCard><EmptyState icon={KeyRound} title="No usage plans yet" description="Plans bind API stages to throttles, quotas and API keys." /></SectionCard> : null}
    {state.status === "ready" && state.items.length > 0 ? <SectionCard title="Plans">
      <ul className="divide-y divide-border">
        {state.items.map((plan) => <li key={plan.id} className="flex flex-wrap items-center gap-2 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{plan.name}</p>
            <p className="text-xs text-muted-foreground">
              {plan.throttle ? `${plan.throttle.rateLimit} rps / ${plan.throttle.burstLimit} burst · ` : ""}
              {plan.quota ? `${plan.quota.limit}/${plan.quota.period}${plan.quota.offset ? ` (offset ${plan.quota.offset})` : ""}` : "no quota"}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => openDetail(plan)}>Details</Button>
        </li>)}
      </ul>
    </SectionCard> : null}
    {selected ? <PlanDetail
      plan={selected}
      projectId={project.id}
      writable={writable}
      onClose={() => setSelected(null)}
      onChanged={async () => { await refresh(); await openDetail(selected); }}
    /> : null}
    {writable ? <Button variant="outline" size="sm" className="hidden" onClick={() => remove(selected)}>Delete</Button> : null}

    <Dialog open={creating} onOpenChange={setCreating}>
      <DialogContent>
        <DialogHeader><DialogTitle>Create usage plan</DialogTitle>
          <DialogDescription>Throttle and quota may not exceed the project level (10 000 rps / 5 000 burst by default).</DialogDescription></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2"><Label htmlFor="plan-name">Name</Label><Input id="plan-name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></div>
          <div className="col-span-2"><Label htmlFor="plan-desc">Description</Label><Input id="plan-desc" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></div>
          <div><Label htmlFor="plan-rate">Throttle rps</Label><Input id="plan-rate" inputMode="numeric" value={form.rate} onChange={(event) => setForm({ ...form, rate: event.target.value })} /></div>
          <div><Label htmlFor="plan-burst">Throttle burst</Label><Input id="plan-burst" inputMode="numeric" value={form.burst} onChange={(event) => setForm({ ...form, burst: event.target.value })} /></div>
          <div><Label htmlFor="plan-limit">Quota limit</Label><Input id="plan-limit" inputMode="numeric" value={form.limit} onChange={(event) => setForm({ ...form, limit: event.target.value })} /></div>
          <div><Label htmlFor="plan-period">Quota period</Label><Input id="plan-period" value={form.period} onChange={(event) => setForm({ ...form, period: event.target.value.toUpperCase() })} placeholder="DAY|WEEK|MONTH" /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
          <Button disabled={busy} onClick={create}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

function PlanDetail({ plan, projectId, writable, onClose, onChanged }) {
  const [busy, setBusy] = useState(false);
  const tab = plan.tab ?? "Settings";
  const setTab = (next) => onChangedRef.current({ ...plan, tab: next });
  const onChangedRef = { current: null };
  onChangedRef.current = async (next) => {
    try {
      const data = await api(projectId, `/${encodeURIComponent(plan.id)}`);
      onChangedRefresh({ ...data, tab: next.tab });
    } catch {
      // Keep the current view on refresh failure.
    }
  };
  const [shadow, setShadow] = useState(null);
  const onChangedRefresh = (next) => setShadow(next);
  const view = shadow ?? plan;

  return <SectionCard title={view.name} description={view.description || "No description."}>
    <div className="flex flex-wrap gap-2 pb-3">
      {TABS.map((name) => <Button key={name} variant={tab === name ? "default" : "outline"} size="sm" onClick={() => setTab(name)}>{name}</Button>)}
      <span className="flex-1" />
      <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
    </div>
    {tab === "Settings" ? <PlanSettings plan={view} projectId={projectId} writable={writable} busy={busy} setBusy={setBusy} onChanged={onChanged} /> : null}
    {tab === "Stages" ? <PlanStages plan={view} projectId={projectId} writable={writable} busy={busy} setBusy={setBusy} onChanged={onChanged} /> : null}
    {tab === "Keys" ? <PlanKeys plan={view} projectId={projectId} writable={writable} busy={busy} setBusy={setBusy} onChanged={onChanged} /> : null}
    {tab === "Usage" ? <PlanUsage plan={view} projectId={projectId} writable={writable} busy={busy} setBusy={setBusy} /> : null}
  </SectionCard>;
}

function PlanSettings({ plan, projectId, writable, busy, setBusy, onChanged }) {
  const [throttle, setThrottle] = useState(JSON.stringify(plan.throttle ?? null));
  const [quota, setQuota] = useState(JSON.stringify(plan.quota ?? null));
  const save = async () => {
    let parsedThrottle = null;
    let parsedQuota = null;
    try {
      parsedThrottle = throttle.trim() === "" || throttle.trim() === "null" ? null : JSON.parse(throttle);
      parsedQuota = quota.trim() === "" || quota.trim() === "null" ? null : JSON.parse(quota);
    } catch {
      toast.error("Throttle and quota must be valid JSON (or null).");
      return;
    }
    setBusy(true);
    try {
      await api(projectId, `/${encodeURIComponent(plan.id)}`, {
        method: "PATCH",
        headers: { "If-Match": String(plan.version) },
        body: JSON.stringify({ throttle: parsedThrottle, quota: parsedQuota }),
      });
      toast.success("Plan settings saved. Runtime picks them up without a redeploy.");
      await onChanged();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };
  return <div className="space-y-3">
    <p className="text-xs text-muted-foreground">Throttle <code className="font-mono">{"{rateLimit, burstLimit}"}</code>; quota <code className="font-mono">{"{limit, period: DAY|WEEK|MONTH, offset?}"}</code>. Values above the project throttle are rejected (422).</p>
    <div><Label>Throttle (JSON or null)</Label><Input className="font-mono text-xs" value={throttle} onChange={(event) => setThrottle(event.target.value)} spellCheck={false} /></div>
    <div><Label>Quota (JSON or null)</Label><Input className="font-mono text-xs" value={quota} onChange={(event) => setQuota(event.target.value)} spellCheck={false} /></div>
    {writable ? <Button variant="outline" size="sm" disabled={busy} onClick={save}>Save settings</Button> : null}
  </div>;
}

function PlanStages({ plan, projectId, writable, busy, setBusy, onChanged }) {
  const [form, setForm] = useState({ apiId: "", stage: "", methodThrottles: "{}" });
  const mutate = async (method, body) => {
    setBusy(true);
    try {
      await api(projectId, `/${encodeURIComponent(plan.id)}/stages`, { method, body: JSON.stringify(body) });
      toast.success(method === "DELETE" ? "Stage removed." : "Stage association saved.");
      await onChanged();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };
  const saveMethods = async (stage) => {
    let parsed;
    try {
      parsed = JSON.parse(form.methodThrottles || "{}");
    } catch {
      toast.error("Method throttles must be valid JSON.");
      return;
    }
    await mutate("PATCH", { apiId: stage.apiId, stage: stage.stage, methodThrottles: parsed });
  };
  return <div className="space-y-3">
    {(plan.stages ?? []).length === 0 ? <p className="text-xs text-muted-foreground">No stages associated. HTTP APIs cannot be added (capability).</p> : null}
    <ul className="space-y-2">
      {(plan.stages ?? []).map((stage) => <li key={`${stage.apiId}:${stage.stage}`} className="rounded-md border border-border p-3 text-xs">
        <p className="font-medium">{stage.stage} <span className="text-muted-foreground">{String(stage.apiId).slice(0, 8)}</span></p>
        <p className="text-muted-foreground">Method throttles: {Object.keys(stage.methodThrottles ?? {}).length === 0 ? "none" : Object.entries(stage.methodThrottles).map(([key, entry]) => `${key} ${entry.rateLimit}/${entry.burstLimit}`).join(", ")}</p>
        {writable ? <div className="flex flex-wrap gap-2 pt-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => saveMethods(stage)}>Apply editor throttles</Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => mutate("DELETE", { apiId: stage.apiId, stage: stage.stage })}>Remove</Button>
        </div> : null}
      </li>)}
    </ul>
    {writable ? <div className="grid grid-cols-2 gap-2">
      <div><Label>API id</Label><Input className="font-mono text-xs" value={form.apiId} onChange={(event) => setForm({ ...form, apiId: event.target.value })} /></div>
      <div><Label>Stage</Label><Input className="font-mono text-xs" value={form.stage} onChange={(event) => setForm({ ...form, stage: event.target.value })} /></div>
      <div className="col-span-2"><Label>Method throttles (JSON, ≤20)</Label><Input className="font-mono text-xs" value={form.methodThrottles} onChange={(event) => setForm({ ...form, methodThrottles: event.target.value })} spellCheck={false} /></div>
      <div className="col-span-2"><Button variant="outline" size="sm" disabled={busy} onClick={async () => {
        let parsed = {};
        try {
          parsed = JSON.parse(form.methodThrottles || "{}");
        } catch {
          toast.error("Method throttles must be valid JSON.");
          return;
        }
        await mutate("POST", { apiId: form.apiId, stage: form.stage, methodThrottles: parsed });
      }}>Add stage</Button></div>
    </div> : null}
  </div>;
}

function PlanKeys({ plan, projectId, writable, busy, setBusy, onChanged }) {
  const [keyId, setKeyId] = useState("");
  const [choices, setChoices] = useState([]);
  useEffect(() => {
    let alive = true;
    apiKeys(projectId, "").then(
      (data) => { if (alive) setChoices(data.items ?? []); },
      () => { if (alive) setChoices([]); },
    );
    return () => { alive = false; };
  }, [projectId]);
  const mutate = async (method, body) => {
    setBusy(true);
    try {
      await api(projectId, `/${encodeURIComponent(plan.id)}/keys`, { method, body: JSON.stringify(body) });
      toast.success(method === "DELETE" ? "Key removed." : "Key added.");
      await onChanged();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };
  const [members, setMembers] = useState([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      const rows = [];
      for (const candidate of choices) {
        try {
          const detail = await apiKeys(projectId, `/${encodeURIComponent(candidate.id)}`);
          if ((detail.plans ?? []).some((entry) => entry.id === plan.id)) rows.push(candidate);
        } catch {
          // Ignore unreadable keys.
        }
      }
      if (alive) setMembers(rows);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, choices, plan.keyCount]);
  return <div className="space-y-3">
    {members.length === 0 ? <p className="text-xs text-muted-foreground">No keys in this plan yet.</p> : <ul className="space-y-2">
      {members.map((key) => <li key={key.id} className="flex items-center gap-2 text-xs">
        <span className="font-medium">{key.name}</span>
        <code className="text-muted-foreground">…{key.prefix}</code>
        {writable ? <Button variant="outline" size="sm" disabled={busy} onClick={() => mutate("DELETE", { keyId: key.id })}>Remove</Button> : null}
      </li>)}
    </ul>}
    {writable ? <div className="flex flex-wrap items-end gap-2">
      <div><Label>Key id or public id</Label><Input className="font-mono text-xs" value={keyId} onChange={(event) => setKeyId(event.target.value)} placeholder="Paste a key id" /></div>
      <Button variant="outline" size="sm" disabled={busy || !keyId} onClick={() => mutate("POST", { keyId })}>Add key</Button>
    </div> : null}
  </div>;
}

function PlanUsage({ plan, projectId, writable, busy, setBusy }) {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [range, setRange] = useState({ start: weekAgo, end: today });
  const [usage, setUsage] = useState(null);
  const [adjust, setAdjust] = useState({ keyId: "", op: "extend", value: "10" });
  const [adjusting, setAdjusting] = useState(false);

  const load = async () => {
    setBusy(true);
    try {
      const data = await api(projectId, `/${encodeURIComponent(plan.id)}/usage?startDate=${encodeURIComponent(range.start)}&endDate=${encodeURIComponent(range.end)}`);
      setUsage(data);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const adjustUsage = async () => {
    if (!adjust.keyId) {
      toast.error("Pick a key public id first.");
      return;
    }
    setAdjusting(true);
    try {
      await api(projectId, `/${encodeURIComponent(plan.id)}/keys/${encodeURIComponent(adjust.keyId)}/usage`, {
        method: "PATCH",
        body: JSON.stringify({ op: adjust.op, ...(adjust.op === "reset" ? {} : { value: Number(adjust.value) }) }),
      });
      toast.success(`Usage ${adjust.op} applied.`);
      await load();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setAdjusting(false);
    }
  };

  const exportCsv = () => {
    if (!usage) return;
    const lines = ["key,date,used,remaining"];
    for (const [keyId, pairs] of Object.entries(usage.items ?? {})) {
      const days = daysBetween(usage.startDate, usage.endDate);
      pairs.forEach(([used, remaining], index) => lines.push(`${keyId},${days[index] ?? ""},${used},${remaining}`));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `usage-${plan.publicId ?? plan.id}.csv`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  };

  return <div className="space-y-3">
    <div className="flex flex-wrap items-end gap-2">
      <div><Label>Start</Label><Input type="date" value={range.start} onChange={(event) => setRange({ ...range, start: event.target.value })} /></div>
      <div><Label>End</Label><Input type="date" value={range.end} onChange={(event) => setRange({ ...range, end: event.target.value })} /></div>
      <Button variant="outline" size="sm" disabled={busy} onClick={load}><CalendarRange className="size-4" />Load usage</Button>
      {usage ? <Button variant="outline" size="sm" onClick={exportCsv}>Export CSV</Button> : null}
    </div>
    {!usage ? <p className="text-xs text-muted-foreground">Today&apos;s numbers are live counters; past days come from rolled-up history.</p> : null}
    {usage ? Object.entries(usage.items ?? {}).map(([keyId, pairs]) => <div key={keyId} className="rounded-md border border-border p-3 text-xs">
      <p className="font-medium">{keyId}</p>
      <table className="mt-2 w-full">
        <thead><tr className="text-left text-muted-foreground"><th>Date</th><th>Used</th><th>Remaining</th></tr></thead>
        <tbody>
          {pairs.map(([used, remaining], index) => <tr key={daysBetween(usage.startDate, usage.endDate)[index] ?? index}>
            <td>{daysBetween(usage.startDate, usage.endDate)[index]}</td><td>{used}</td><td>{remaining}</td>
          </tr>)}
        </tbody>
      </table>
    </div>) : null}
    {Object.keys(usage?.items ?? {}).length === 0 && usage ? <p className="text-xs text-muted-foreground">No traffic yet.</p> : null}
    {writable ? <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
      <div><Label>Key public id</Label><Input className="font-mono text-xs" value={adjust.keyId} onChange={(event) => setAdjust({ ...adjust, keyId: event.target.value })} /></div>
      <div><Label>Operation</Label><Input className="font-mono text-xs" value={adjust.op} onChange={(event) => setAdjust({ ...adjust, op: event.target.value })} placeholder="extend|reset|set" /></div>
      <div><Label>Value</Label><Input className="font-mono text-xs" inputMode="numeric" value={adjust.value} onChange={(event) => setAdjust({ ...adjust, value: event.target.value })} /></div>
      <Button variant="outline" size="sm" disabled={adjusting} onClick={adjustUsage}>Apply</Button>
    </div> : null}
  </div>;
}

function daysBetween(start, end) {
  const out = [];
  for (let day = start; day <= end; day = addOneDay(day)) out.push(day);
  return out;
}

function addOneDay(day) {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
