"use client";

import { useCallback, useEffect, useState } from "react";
import { Gauge } from "lucide-react";
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

function toCsv(items) {
  const lines = ["keyId,day,used,remaining"];
  for (const [keyId, series] of Object.entries(items ?? {})) {
    series.forEach(([used, remaining], index) => {
      lines.push(`${keyId},+${index},${used},${remaining ?? ""}`);
    });
  }
  return lines.join("\n");
}

/**
 * Usage plans screen (S08 §7): list; detail with tabs Settings (throttle,
 * quota), Associated stages (add API+stage, per-method throttles), API keys
 * (attach/detach), Usage (date range, per-key daily used/remaining table,
 * export CSV, extend/reset dialog).
 */
export function UsagePlansScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [selected, setSelected] = useState(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setState({ status: "loading", items: [], error: null });
    try {
      const data = await call(project.id, "/usage-plans");
      setState({ status: "ready", items: data.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [project.id]);

  useEffect(() => {
    let alive = true;
    call(project.id, "/usage-plans").then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id]);

  const create = async () => {
    if (!name.trim()) {
      toast.error("Name is required.");
      return;
    }
    setBusy(true);
    try {
      await call(project.id, "/usage-plans", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      setName("");
      toast.success("Usage plan created.");
      refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (plan) => {
    try {
      await call(project.id, `/usage-plans/${encodeURIComponent(plan.id)}`, { method: "DELETE" });
      if (selected?.id === plan.id) setSelected(null);
      toast.success("Usage plan deleted.");
      refresh();
    } catch (error) {
      toast.error(error.message);
    }
  };

  return <div className="space-y-4">
    <ScreenHeader
      title="Usage plans"
      description="Bind API keys to API stages with throttle and quota ceilings. Changes apply without a redeploy."
    />
    <SectionCard title="Create plan">
      <div className="flex gap-2">
        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="bronze" />
        <Button size="sm" disabled={busy || !can("pods.usage_plan.write")} onClick={create}>Create</Button>
      </div>
    </SectionCard>
    {state.status === "loading" ? <SectionCard><div className="flex justify-center py-10"><LogoLoading /></div></SectionCard> : null}
    {state.status === "error" ? <SectionCard><EmptyState icon={Gauge} title="Plans unavailable" description={state.error} action={<Button variant="outline" onClick={refresh}>Retry</Button>} /></SectionCard> : null}
    {state.status === "ready" && state.items.length === 0 ? <SectionCard><EmptyState icon={Gauge} title="No usage plans yet" description="Create the first plan above, then attach stages and keys." /></SectionCard> : null}
    {state.status === "ready" && state.items.length > 0 ? <SectionCard title="Plans">
      <ul className="space-y-2">
        {state.items.map((plan) => <li key={plan.id} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{plan.name}</span>
          {plan.throttle ? <Badge variant="outline">{plan.throttle.rateLimit} rps / {plan.throttle.burstLimit}</Badge> : null}
          {plan.quota ? <Badge variant="outline">{plan.quota.limit}/{plan.quota.period}</Badge> : null}
          <Button variant="outline" size="sm" onClick={() => setSelected(plan)}>Details</Button>
          <Button variant="ghost" size="sm" disabled={!can("pods.usage_plan.write")} onClick={() => remove(plan)}>Delete</Button>
        </li>)}
      </ul>
    </SectionCard> : null}
    {selected ? <PlanDetail projectId={project.id} plan={selected} can={can} onClose={() => setSelected(null)} onChanged={refresh} /> : null}
  </div>;
}

function PlanDetail({ projectId, plan, can, onClose, onChanged }) {
  const [tab, setTab] = useState("settings");
  const [detail, setDetail] = useState({ status: "loading", data: null });
  const [throttleText, setThrottleText] = useState("{}");
  const [quotaText, setQuotaText] = useState("{}");
  const [stageForm, setStageForm] = useState({ apiId: "", stage: "", methodThrottles: "{}" });
  const [keyId, setKeyId] = useState("");
  const [usage, setUsage] = useState({ status: "idle", data: null });
  const [range, setRange] = useState({ startDate: "", endDate: "" });
  const [adjust, setAdjust] = useState({ keyId: "", op: "extend", value: "10" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setDetail({ status: "loading", data: null });
    try {
      const data = await call(projectId, `/usage-plans/${encodeURIComponent(plan.id)}`);
      setDetail({ status: "ready", data });
      setThrottleText(JSON.stringify(data.throttle ?? null));
      setQuotaText(JSON.stringify(data.quota ?? null));
    } catch (error) {
      setDetail({ status: "error", data: null, error: error.message });
    }
  }, [projectId, plan.id]);

  useEffect(() => {
    let alive = true;
    call(projectId, `/usage-plans/${encodeURIComponent(plan.id)}`).then(
      (data) => {
        if (!alive) return;
        setDetail({ status: "ready", data });
        setThrottleText(JSON.stringify(data.throttle ?? null));
        setQuotaText(JSON.stringify(data.quota ?? null));
      },
      (error) => { if (alive) setDetail({ status: "error", data: null, error: error.message }); },
    );
    return () => { alive = false; };
  }, [projectId, plan.id]);

  const saveSettings = async () => {
    let throttle = null;
    let quota = null;
    try {
      throttle = throttleText.trim() === "" || throttleText.trim() === "null" ? null : JSON.parse(throttleText);
      quota = quotaText.trim() === "" || quotaText.trim() === "null" ? null : JSON.parse(quotaText);
    } catch {
      toast.error("Throttle and quota must be valid JSON (or null).");
      return;
    }
    setBusy(true);
    try {
      await call(projectId, `/usage-plans/${encodeURIComponent(plan.id)}`, {
        method: "PATCH",
        headers: { "If-Match": String(detail.data.version) },
        body: JSON.stringify({ throttle, quota }),
      });
      toast.success("Plan settings saved. Runtimes apply them within a minute.");
      load();
      onChanged();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const attachStage = async () => {
    let methodThrottles = {};
    try {
      methodThrottles = stageForm.methodThrottles.trim() === "" ? {} : JSON.parse(stageForm.methodThrottles);
    } catch {
      toast.error("Method throttles must be valid JSON.");
      return;
    }
    try {
      await call(projectId, `/usage-plans/${encodeURIComponent(plan.id)}/stages`, {
        method: "POST",
        body: JSON.stringify({ apiId: stageForm.apiId.trim(), stage: stageForm.stage.trim(), methodThrottles }),
      });
      toast.success("Stage attached.");
      setStageForm({ apiId: "", stage: "", methodThrottles: "{}" });
      load();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const detachStage = async (entry) => {
    try {
      await call(projectId, `/usage-plans/${encodeURIComponent(plan.id)}/stages?apiId=${encodeURIComponent(entry.apiId)}&stage=${encodeURIComponent(entry.stage)}`, { method: "DELETE" });
      toast.success("Stage detached.");
      load();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const attachKey = async () => {
    if (!keyId.trim()) {
      toast.error("Key id is required.");
      return;
    }
    try {
      await call(projectId, `/usage-plans/${encodeURIComponent(plan.id)}/keys`, {
        method: "POST",
        body: JSON.stringify({ keyId: keyId.trim() }),
      });
      setKeyId("");
      toast.success("Key attached.");
      load();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const detachKey = async (id) => {
    try {
      await call(projectId, `/usage-plans/${encodeURIComponent(plan.id)}/keys?keyId=${encodeURIComponent(id)}`, { method: "DELETE" });
      toast.success("Key detached.");
      load();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const loadUsage = async () => {
    setUsage({ status: "loading", data: null });
    try {
      const query = new URLSearchParams();
      if (range.startDate) query.set("startDate", range.startDate);
      if (range.endDate) query.set("endDate", range.endDate);
      const suffix = query.toString() === "" ? "" : `?${query.toString()}`;
      const data = await call(projectId, `/usage-plans/${encodeURIComponent(plan.id)}/usage${suffix}`);
      setUsage({ status: "ready", data });
    } catch (error) {
      setUsage({ status: "error", data: null, error: error.message });
    }
  };

  const adjustUsage = async () => {
    if (!adjust.keyId.trim()) {
      toast.error("Key id is required.");
      return;
    }
    setBusy(true);
    try {
      await call(projectId, `/usage-plans/${encodeURIComponent(plan.id)}/keys/${encodeURIComponent(adjust.keyId.trim())}/usage`, {
        method: "PATCH",
        body: JSON.stringify({ op: adjust.op, value: adjust.op === "reset" ? null : Number(adjust.value) }),
      });
      toast.success(`Usage ${adjust.op}ed.`);
      loadUsage();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = () => {
    if (!usage.data) return;
    const blob = new Blob([toCsv(usage.data.items)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `usage-${plan.id}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  if (detail.status === "loading") return <SectionCard><div className="flex justify-center py-6"><LogoLoading /></div></SectionCard>;
  if (detail.status === "error") return <SectionCard><EmptyState icon={Gauge} title="Plan unavailable" description={detail.error} action={<Button variant="outline" onClick={load}>Retry</Button>} /></SectionCard>;
  const data = detail.data;
  return <SectionCard title={data.name} description="Plan detail">
    <div className="mb-3 flex gap-2">
      {["settings", "stages", "keys", "usage"].map((name) => <Button
        key={name}
        variant={tab === name ? "default" : "outline"}
        size="sm"
        onClick={() => setTab(name)}
      >{name[0].toUpperCase()}{name.slice(1)}</Button>)}
      <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
    </div>
    {tab === "settings" ? <div className="grid gap-2">
      <Label>Throttle JSON ({`{rateLimit, burstLimit}`} or null; may not exceed the project level)</Label>
      <textarea className="min-h-16 w-full rounded-md border border-input bg-background p-2 font-mono text-xs" value={throttleText} onChange={(event) => setThrottleText(event.target.value)} spellCheck={false} />
      <Label>Quota JSON ({`{limit, offset, period: DAY|WEEK|MONTH}`} or null)</Label>
      <textarea className="min-h-16 w-full rounded-md border border-input bg-background p-2 font-mono text-xs" value={quotaText} onChange={(event) => setQuotaText(event.target.value)} spellCheck={false} />
      <div><Button size="sm" disabled={busy || !can("pods.usage_plan.write")} onClick={saveSettings}>Save settings</Button></div>
    </div> : null}
    {tab === "stages" ? <div className="grid gap-2">
      <Label>API id</Label>
      <Input value={stageForm.apiId} onChange={(event) => setStageForm({ ...stageForm, apiId: event.target.value })} placeholder="api uuid or public id" />
      <Label>Stage name</Label>
      <Input value={stageForm.stage} onChange={(event) => setStageForm({ ...stageForm, stage: event.target.value })} placeholder="prod" />
      <Label>Per-method throttles ({`{"/pets/GET": {rateLimit, burstLimit}}`}, ≤20)</Label>
      <textarea className="min-h-16 w-full rounded-md border border-input bg-background p-2 font-mono text-xs" value={stageForm.methodThrottles} onChange={(event) => setStageForm({ ...stageForm, methodThrottles: event.target.value })} spellCheck={false} />
      <div><Button size="sm" disabled={!can("pods.usage_plan.write")} onClick={attachStage}>Attach stage</Button></div>
      <ul className="space-y-1 text-sm">
        {(data.stages ?? []).map((entry) => <li key={`${entry.apiId}:${entry.stage}`} className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs">{entry.apiId}:{entry.stage}</span>
          <span className="text-xs text-muted-foreground">{Object.keys(entry.methodThrottles ?? {}).length} method override(s)</span>
          <Button variant="ghost" size="sm" disabled={!can("pods.usage_plan.write")} onClick={() => detachStage(entry)}>Detach</Button>
        </li>)}
        {(data.stages ?? []).length === 0 ? <li className="text-muted-foreground">No stages attached.</li> : null}
      </ul>
    </div> : null}
    {tab === "keys" ? <div className="grid gap-2">
      <div className="flex gap-2">
        <Input value={keyId} onChange={(event) => setKeyId(event.target.value)} placeholder="key uuid" />
        <Button size="sm" disabled={!can("pods.usage_plan.write")} onClick={attachKey}>Attach</Button>
      </div>
      <ul className="space-y-1 text-sm">
        {(data.keys ?? []).map((entry) => <li key={entry.id} className="flex items-center gap-2">
          <code className="text-xs">{entry.id}</code>
          <Button variant="ghost" size="sm" disabled={!can("pods.usage_plan.write")} onClick={() => detachKey(entry.id)}>Detach</Button>
        </li>)}
        {(data.keys ?? []).length === 0 ? <li className="text-muted-foreground">No keys attached. A key cannot join two plans covering the same stage.</li> : null}
      </ul>
    </div> : null}
    {tab === "usage" ? <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        <Input type="date" value={range.startDate} onChange={(event) => setRange({ ...range, startDate: event.target.value })} />
        <Input type="date" value={range.endDate} onChange={(event) => setRange({ ...range, endDate: event.target.value })} />
        <Button variant="outline" size="sm" disabled={!can("pods.usage.view")} onClick={loadUsage}>Load usage</Button>
        <Button variant="outline" size="sm" disabled={!usage.data} onClick={exportCsv}>Export CSV</Button>
      </div>
      {usage.status === "ready" && Object.keys(usage.data.items ?? {}).length === 0 ? <p className="text-sm text-muted-foreground">No traffic yet.</p> : null}
      {usage.status === "ready" ? Object.entries(usage.data.items ?? {}).map(([id, series]) => <div key={id} className="text-sm">
        <code className="text-xs">{id}</code>
        <table className="mt-1 w-full text-xs">
          <thead><tr><th className="text-left">Day offset</th><th className="text-left">Used</th><th className="text-left">Remaining</th></tr></thead>
          <tbody>
            {series.map(([used, remaining], index) => <tr key={index}><td>+{index}</td><td>{used}</td><td>{remaining ?? "—"}</td></tr>)}
          </tbody>
        </table>
      </div>) : null}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
        <Input className="max-w-64" value={adjust.keyId} onChange={(event) => setAdjust({ ...adjust, keyId: event.target.value })} placeholder="key uuid" />
        <select className="rounded-md border border-input bg-background p-1 text-sm" value={adjust.op} onChange={(event) => setAdjust({ ...adjust, op: event.target.value })}>
          <option value="extend">extend</option>
          <option value="reset">reset</option>
          <option value="set">set</option>
        </select>
        {adjust.op === "reset" ? null : <Input className="max-w-32" value={adjust.value} onChange={(event) => setAdjust({ ...adjust, value: event.target.value })} placeholder="10" />}
        <Button size="sm" disabled={busy || !can("pods.usage_plan.write")} onClick={adjustUsage}>Apply</Button>
      </div>
    </div> : null}
  </SectionCard>;
}
