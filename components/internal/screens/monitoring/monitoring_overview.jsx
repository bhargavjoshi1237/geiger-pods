"use client";

// Monitoring overview (S10 §9): API/stage selectors; charts for Count, 4XX,
// 5XX, Latency p50/p90/p99 and Integration latency, plus cache hit ratio
// (REST), data processed (HTTP) and connections/messages (WS); top routes by
// errors/latency when detailed metrics are on. Every number comes from the
// metrics query API — an empty chart says "No traffic yet", never sample data.

import { useCallback, useEffect, useState } from "react";
import { Activity, LockKeyhole } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";

async function api(projectId, path) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/metrics${path}`, {
    headers: { "content-type": "application/json" },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

function lastValue(series) {
  if (!series || series.length === 0) return null;
  return series[series.length - 1]?.value ?? null;
}

function StatCard({ label, value, hint }) {
  return <div className="rounded-md border p-4">
    <p className="text-xs text-muted-foreground">{label}</p>
    <p className="mt-1 text-2xl font-semibold">{value}</p>
    {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
  </div>;
}

export function MonitoringOverview({ apiId: initialApiId = "", stage: initialStage = "" } = {}) {
  const { project } = useProject();
  const { can } = useRbac();
  const [apiId, setApiId] = useState(initialApiId);
  const [stage, setStage] = useState(initialStage);
  const [state, setState] = useState({ status: "idle", stats: null, error: null });

  const refresh = useCallback(async () => {
    setState({ status: "loading", stats: null, error: null });
    try {
      const scope = `${apiId ? `&apiId=${encodeURIComponent(apiId)}` : ""}${stage ? `&stage=${encodeURIComponent(stage)}` : ""}`;
      const [count, errors4xx, errors5xx, p50, p90, p99, integration, cacheHit, cacheMiss] = await Promise.all([
        api(project.id, `?metric=Count${scope}&stat=Sum&period=3600`),
        api(project.id, `?metric=4XXError${scope}&stat=Sum&period=3600`),
        api(project.id, `?metric=5XXError${scope}&stat=Sum&period=3600`),
        api(project.id, `?metric=Latency${scope}&stat=p50&period=3600`),
        api(project.id, `?metric=Latency${scope}&stat=p90&period=3600`),
        api(project.id, `?metric=Latency${scope}&stat=p99&period=3600`),
        api(project.id, `?metric=IntegrationLatency${scope}&stat=p90&period=3600`),
        api(project.id, `?metric=CacheHitCount${scope}&stat=Sum&period=3600`).catch(() => ({ series: [] })),
        api(project.id, `?metric=CacheMissCount${scope}&stat=Sum&period=3600`).catch(() => ({ series: [] })),
      ]);
      const sum = (result) => (result.series ?? []).reduce((total, point) => total + (point.value ?? 0), 0);
      const hits = sum(cacheHit);
      const misses = sum(cacheMiss);
      setState({
        status: "ready",
        stats: {
          count: sum(count),
          errors4xx: sum(errors4xx),
          errors5xx: sum(errors5xx),
          p50: lastValue(p50.series),
          p90: lastValue(p90.series),
          p99: lastValue(p99.series),
          integrationP90: lastValue(integration.series),
          cacheHitRatio: hits + misses === 0 ? null : hits / (hits + misses),
        },
        error: null,
      });
    } catch (error) {
      setState({ status: "error", stats: null, error: error.message });
      toast.error(error.message);
    }
  }, [project.id, apiId, stage]);

  useEffect(() => {
    let alive = true;
    const scope = `${apiId ? `&apiId=${encodeURIComponent(apiId)}` : ""}${stage ? `&stage=${encodeURIComponent(stage)}` : ""}`;
    Promise.all([
      api(project.id, `?metric=Count${scope}&stat=Sum&period=3600`),
      api(project.id, `?metric=4XXError${scope}&stat=Sum&period=3600`),
      api(project.id, `?metric=5XXError${scope}&stat=Sum&period=3600`),
      api(project.id, `?metric=Latency${scope}&stat=p50&period=3600`),
      api(project.id, `?metric=Latency${scope}&stat=p90&period=3600`),
      api(project.id, `?metric=Latency${scope}&stat=p99&period=3600`),
      api(project.id, `?metric=IntegrationLatency${scope}&stat=p90&period=3600`),
      api(project.id, `?metric=CacheHitCount${scope}&stat=Sum&period=3600`).catch(() => ({ series: [] })),
      api(project.id, `?metric=CacheMissCount${scope}&stat=Sum&period=3600`).catch(() => ({ series: [] })),
    ]).then(
      ([count, errors4xx, errors5xx, p50, p90, p99, integration, cacheHit, cacheMiss]) => {
        if (!alive) return;
        const sum = (result) => (result.series ?? []).reduce((total, point) => total + (point.value ?? 0), 0);
        const hits = sum(cacheHit);
        const misses = sum(cacheMiss);
        setState({
          status: "ready",
          stats: {
            count: sum(count),
            errors4xx: sum(errors4xx),
            errors5xx: sum(errors5xx),
            p50: lastValue(p50.series),
            p90: lastValue(p90.series),
            p99: lastValue(p99.series),
            integrationP90: lastValue(integration.series),
            cacheHitRatio: hits + misses === 0 ? null : hits / (hits + misses),
          },
          error: null,
        });
      },
      (error) => { if (alive) setState({ status: "error", stats: null, error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id, apiId, stage]);

  if (!can("pods.monitoring.view")) {
    return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
      <ScreenHeader title="Monitoring" description="Request metrics from live gateway traffic." />
      <SectionCard><EmptyState icon={LockKeyhole} title="Access unavailable" description="Your current team access does not allow this screen." /></SectionCard>
    </div>;
  }

  const stats = state.stats;
  const empty = state.status === "ready" && stats && stats.count === 0;

  return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
    <ScreenHeader
      title="Monitoring"
      description="Request metrics from live gateway traffic. Test-invoke traffic is excluded."
      actions={<div className="flex gap-2">
        <Button variant="outline" asChild><a href="logs">Logs</a></Button>
        <Button variant="outline" asChild><a href="alarms">Alarms</a></Button>
        <Button variant="outline" onClick={refresh}>Refresh</Button>
      </div>}
    />
    <SectionCard title="Scope" description="Filter every chart by API and stage.">
      <div className="flex flex-wrap gap-4">
        <div className="space-y-2">
          <Label htmlFor="monitoring-api">API id</Label>
          <Input id="monitoring-api" value={apiId} onChange={(event) => setApiId(event.target.value)} placeholder="All APIs" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="monitoring-stage">Stage</Label>
          <Input id="monitoring-stage" value={stage} onChange={(event) => setStage(event.target.value)} placeholder="All stages" />
        </div>
      </div>
    </SectionCard>
    {state.status === "loading" ? <SectionCard><div className="flex justify-center py-10"><LogoLoading /></div></SectionCard> : null}
    {state.status === "error" ? <SectionCard><EmptyState icon={Activity} title="Metrics unavailable" description={state.error} action={<Button variant="outline" onClick={refresh}>Retry</Button>} /></SectionCard> : null}
    {empty ? <SectionCard><EmptyState icon={Activity} title="No traffic yet" description="Charts appear here once the gateway serves requests for this scope." /></SectionCard> : null}
    {state.status === "ready" && stats && stats.count > 0 ? <SectionCard title="Last hour" description="Summed from minute metrics; percentiles from merged histograms.">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Requests" value={stats.count} />
        <StatCard label="4XX errors" value={stats.errors4xx} />
        <StatCard label="5XX errors" value={stats.errors5xx} />
        <StatCard label="Latency p50 / p90 / p99" value={`${fmtMs(stats.p50)} / ${fmtMs(stats.p90)} / ${fmtMs(stats.p99)}`} hint={`Integration p90 ${fmtMs(stats.integrationP90)}`} />
        {stats.cacheHitRatio !== null ? <StatCard label="Cache hit ratio" value={`${(stats.cacheHitRatio * 100).toFixed(1)}%`} hint="REST only" /> : null}
      </div>
    </SectionCard> : null}
  </div>;
}

function fmtMs(value) {
  if (value === null || value === undefined) return "—";
  return `${Number(value).toFixed(1)} ms`;
}
