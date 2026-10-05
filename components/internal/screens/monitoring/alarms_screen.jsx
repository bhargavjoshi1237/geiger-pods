"use client";

// Alarms screen (S10 §9): list with state badges, create wizard
// (metric → condition → actions) and history.

import { useCallback, useEffect, useState } from "react";
import { BellRing, LockKeyhole, Plus } from "lucide-react";
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
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/alarms${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

const STATE_VARIANT = { OK: "outline", ALARM: "destructive", INSUFFICIENT_DATA: "secondary" };

export function AlarmsScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [creating, setCreating] = useState(false);
  const [history, setHistory] = useState(null);
  const [busy, setBusy] = useState(false);
  const writable = can("pods.alarm.write");

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
      <ScreenHeader title="Alarms" description="CloudWatch-style alarms over gateway metrics." />
      <SectionCard><EmptyState icon={LockKeyhole} title="Access unavailable" description="Your current team access does not allow this screen." /></SectionCard>
    </div>;
  }

  return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
    <ScreenHeader
      title="Alarms"
      description="CloudWatch-style M-of-N alarms. Transitions notify exactly once."
      actions={writable ? <Button onClick={() => setCreating(true)}><Plus className="size-4" />New alarm</Button> : null}
    />
    {state.status === "loading" ? <SectionCard><div className="flex justify-center py-10"><LogoLoading /></div></SectionCard> : null}
    {state.status === "error" ? <SectionCard><EmptyState icon={BellRing} title="Alarms unavailable" description={state.error} action={<Button variant="outline" onClick={refresh}>Retry</Button>} /></SectionCard> : null}
    {state.status === "ready" && state.items.length === 0 ? <SectionCard><EmptyState icon={BellRing} title="No alarms yet" description="Create one to get notified when a metric breaches its threshold." action={writable ? <Button onClick={() => setCreating(true)}>New alarm</Button> : undefined} /></SectionCard> : null}
    {state.status === "ready" && state.items.length > 0 ? <SectionCard title="Alarms" description={`${state.items.length} alarm${state.items.length === 1 ? "" : "s"}.`}>
      <ul className="divide-y divide-border">
        {state.items.map((alarm) => <li key={alarm.id} className="flex flex-wrap items-center gap-3 py-4 first:pt-0 last:pb-0">
          <Badge variant={STATE_VARIANT[alarm.state] ?? "outline"}>{alarm.state}</Badge>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{alarm.name}</p>
            <p className="mt-1 font-mono text-xs text-muted-foreground">{alarm.metric} {alarm.statistic} {alarm.comparison} {alarm.threshold} · {alarm.datapointsToAlarm ?? alarm.evaluationPeriods} of {alarm.evaluationPeriods} × {alarm.periodSec}s</p>
            {alarm.stateReason ? <p className="mt-1 text-xs text-muted-foreground">{alarm.stateReason}</p> : null}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={async () => {
              try {
                const data = await api(project.id, `/${encodeURIComponent(alarm.id)}/history`);
                setHistory({ alarm, items: data.items ?? [] });
              } catch (error) {
                toast.error(error.message);
              }
            }}>History</Button>
            {writable ? <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(project.id, `/${encodeURIComponent(alarm.id)}`, { method: "DELETE" });
                  toast.success(`Deleted ${alarm.name}.`);
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
    {history ? <SectionCard
      title={`History — ${history.alarm.name}`}
      description="State transitions with reasons."
      actions={<Button variant="outline" size="sm" onClick={() => setHistory(null)}>Close</Button>}
    >
      {history.items.length === 0 ? <p className="text-sm text-muted-foreground">No transitions yet.</p> : <ul className="divide-y divide-border">
        {history.items.map((entry) => <li key={entry.id} className="py-2 font-mono text-xs">
          {entry.created_at}: {entry.from_state} → {entry.to_state} — {entry.reason}
        </li>)}
      </ul>}
    </SectionCard> : null}
    <Dialog open={creating} onOpenChange={setCreating}>
      <DialogContent>
        <DialogHeader><DialogTitle>New alarm</DialogTitle><DialogDescription>Metric → condition → actions (channel ids).</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const payload = {
            name: String(form.get("name") ?? "").trim(),
            metric: String(form.get("metric") ?? "").trim(),
            statistic: String(form.get("statistic") ?? "Sum"),
            comparison: String(form.get("comparison") ?? ">"),
            threshold: Number(form.get("threshold") ?? 0),
            periodSec: Number(form.get("periodSec") ?? 300),
            evaluationPeriods: Number(form.get("evaluationPeriods") ?? 3),
            datapointsToAlarm: Number(form.get("datapointsToAlarm") ?? 2),
            treatMissingData: String(form.get("treatMissingData") ?? "missing"),
          };
          setBusy(true);
          api(project.id, "", { method: "POST", body: JSON.stringify(payload) }).then(
            () => {
              toast.success("Alarm created.");
              setCreating(false);
              void refresh();
            },
            (error) => toast.error(error.message),
          ).finally(() => setBusy(false));
        }}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="alarm-name">Name</Label><Input id="alarm-name" name="name" required placeholder="high-5xx" /></div>
            <div className="space-y-2"><Label htmlFor="alarm-metric">Metric</Label><Input id="alarm-metric" name="metric" required placeholder="5XXError" /></div>
            <div className="space-y-2"><Label htmlFor="alarm-statistic">Statistic</Label><Input id="alarm-statistic" name="statistic" defaultValue="Sum" /></div>
            <div className="space-y-2"><Label htmlFor="alarm-comparison">Comparison</Label><Input id="alarm-comparison" name="comparison" defaultValue=">" /></div>
            <div className="space-y-2"><Label htmlFor="alarm-threshold">Threshold</Label><Input id="alarm-threshold" name="threshold" type="number" step="any" defaultValue="10" /></div>
            <div className="space-y-2"><Label htmlFor="alarm-period">Period (s, multiple of 60)</Label><Input id="alarm-period" name="periodSec" type="number" defaultValue="300" /></div>
            <div className="space-y-2"><Label htmlFor="alarm-periods">Evaluation periods (N)</Label><Input id="alarm-periods" name="evaluationPeriods" type="number" defaultValue="3" /></div>
            <div className="space-y-2"><Label htmlFor="alarm-datapoints">Datapoints to alarm (M)</Label><Input id="alarm-datapoints" name="datapointsToAlarm" type="number" defaultValue="2" /></div>
            <div className="space-y-2"><Label htmlFor="alarm-missing">Treat missing data</Label><Input id="alarm-missing" name="treatMissingData" defaultValue="missing" /></div>
          </div>
          <DialogFooter><Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create alarm"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>;
}
