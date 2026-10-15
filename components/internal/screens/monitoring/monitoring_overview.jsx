"use client";

// Monitoring dashboard: request, error and latency metrics plus cache hit
// ratio (REST) for a time range, scoped to an API and stage. Every number
// comes from the metrics query API — an empty scope says so, never sample
// data. Embedded in the API editor (`apiId` set) it renders as a section body.

import { useEffect, useMemo, useState } from "react";
import { Activity, LockKeyhole, RefreshCw } from "lucide-react";
import { Area, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import { Button } from "@geiger/ui/button";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@geiger/ui/chart";
import { EmptyState, LoadingArea, ScreenHeader, SectionCard, SettingRow, SettingsList, StatsBar, Toolbar } from "@/components/internal/shared/screen_kit";
import { MainScreenWrapper } from "@/components/internal/shared/screen_wrappers";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import FilterDropdown from "../overview/filter_dropdown";

const SECONDARY = "h-9 border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

const RANGES = {
  "1h": { label: "Last hour", ms: 3600 * 1000, period: 300, interval: "5 minutes" },
  "24h": { label: "Last 24 hours", ms: 24 * 3600 * 1000, period: 3600, interval: "hour" },
  "7d": { label: "Last 7 days", ms: 7 * 24 * 3600 * 1000, period: 3600, interval: "hour" },
  "30d": { label: "Last 30 days", ms: 30 * 24 * 3600 * 1000, period: 86400, interval: "day" },
};

// Dropdown sentinel for "no filter"; the query omits the parameter.
const ALL = "all";

const RANGE_OPTIONS = Object.entries(RANGES).map(([value, entry]) => ({ value, label: entry.label }));

// Theme-aware series colors; errors keep their semantic hues.
const INK = "var(--foreground)";
const GRID = "var(--border)";
const TICK = "var(--text-tertiary)";
const ramp = (pct) => `color-mix(in srgb, var(--foreground) ${pct}%, var(--surface-subtle))`;

const TRAFFIC_SERIES = [
  { key: "requests", label: "Requests", color: INK, type: "area" },
  { key: "errors4xx", label: "4XX errors", color: "#f59e0b", type: "line" },
  { key: "errors5xx", label: "5XX errors", color: "#ef4444", type: "line" },
];

const LATENCY_SERIES = [
  { key: "p50", label: "p50", color: ramp(45), type: "line" },
  { key: "p90", label: "p90", color: INK, type: "line" },
  { key: "p99", label: "p99", color: ramp(70), type: "line", dashed: true },
];

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

async function getJson(projectId, path) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}${path}`, {
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

function bucketLabel(ms, range) {
  const date = new Date(ms);
  if (range === "30d") return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (range === "7d") return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric" });
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

async function loadMetrics(projectId, { apiId, stage, range }) {
  const { ms, period } = RANGES[range];
  const now = Date.now();
  const from = now - ms;
  const scope = `${apiId ? `&apiId=${encodeURIComponent(apiId)}` : ""}${stage ? `&stage=${encodeURIComponent(stage)}` : ""}&period=${period}&from=${encodeURIComponent(new Date(from).toISOString())}`;
  const query = (metric, stat) => getJson(projectId, `/metrics?metric=${metric}${scope}&stat=${stat}`);
  const [count, errors4xx, errors5xx, p50, p90, p99, integration, cacheHit, cacheMiss] = await Promise.all([
    query("Count", "Sum"),
    query("4XXError", "Sum"),
    query("5XXError", "Sum"),
    query("Latency", "p50"),
    query("Latency", "p90"),
    query("Latency", "p99"),
    query("IntegrationLatency", "p90"),
    query("CacheHitCount", "Sum").catch(() => ({ series: [] })),
    query("CacheMissCount", "Sum").catch(() => ({ series: [] })),
  ]);
  const sum = (result) => (result.series ?? []).reduce((total, point) => total + (point.value ?? 0), 0);
  const hits = sum(cacheHit);
  const misses = sum(cacheMiss);

  // Fill every bucket in the range so quiet intervals read as zero, not as a gap in time.
  const step = period * 1000;
  const buckets = [];
  for (let at = Math.floor(from / step) * step; at <= now; at += step) buckets.push(at);
  const byBucket = (result) => new Map((result.series ?? []).map((point) => [Math.floor(Date.parse(point.ts) / step) * step, point.value]));
  const counts = { requests: byBucket(count), errors4xx: byBucket(errors4xx), errors5xx: byBucket(errors5xx) };
  const latency = { p50: byBucket(p50), p90: byBucket(p90), p99: byBucket(p99) };

  return {
    count: sum(count),
    errors4xx: sum(errors4xx),
    errors5xx: sum(errors5xx),
    p50: lastValue(p50.series),
    p90: lastValue(p90.series),
    p99: lastValue(p99.series),
    integrationP90: lastValue(integration.series),
    cacheHitRatio: hits + misses === 0 ? null : hits / (hits + misses),
    traffic: buckets.map((at) => ({
      label: bucketLabel(at, range),
      requests: counts.requests.get(at) ?? 0,
      errors4xx: counts.errors4xx.get(at) ?? 0,
      errors5xx: counts.errors5xx.get(at) ?? 0,
    })),
    latency: buckets.map((at) => ({
      label: bucketLabel(at, range),
      p50: latency.p50.get(at) ?? null,
      p90: latency.p90.get(at) ?? null,
      p99: latency.p99.get(at) ?? null,
    })),
  };
}

// Stage names per API, for the scope filters. A user without API visibility
// still gets the dashboard, just with "All" scopes.
function useScopeOptions(projectId, fixedApiId) {
  const [scope, setScope] = useState({ apis: [], stagesByApi: {} });

  useEffect(() => {
    let alive = true;
    const stagesOf = (ref) => getJson(projectId, `/apis/${encodeURIComponent(ref)}/stages`)
      .then((data) => (data.items ?? []).map((stage) => stage.name).filter(Boolean))
      .catch(() => []);
    (async () => {
      if (fixedApiId) {
        const names = await stagesOf(fixedApiId);
        if (alive) setScope({ apis: [], stagesByApi: { [fixedApiId]: names } });
        return;
      }
      const apis = await getJson(projectId, "/apis?limit=100").then((data) => data.items ?? []).catch(() => []);
      const lists = await Promise.all(apis.map((api) => stagesOf(api.id)));
      if (alive) setScope({ apis, stagesByApi: Object.fromEntries(apis.map((api, index) => [api.id, lists[index]])) });
    })();
    return () => { alive = false; };
  }, [projectId, fixedApiId]);

  return scope;
}

export function MonitoringOverview({ apiId: initialApiId = "", stage: initialStage = "" } = {}) {
  const { project } = useProject();
  const { can } = useRbac();
  const embedded = Boolean(initialApiId);
  const [apiId, setApiId] = useState(initialApiId);
  const [stage, setStage] = useState(initialStage);
  const [range, setRange] = useState("24h");
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState({ key: null, status: "loading", stats: null, error: null });
  const allowed = can("pods.monitoring.view");
  const scopeOptions = useScopeOptions(project.id, embedded ? initialApiId : "");

  const scopeKey = `${apiId}|${stage}|${range}|${nonce}`;
  useEffect(() => {
    if (!allowed) return undefined;
    let alive = true;
    loadMetrics(project.id, { apiId, stage, range }).then(
      (stats) => { if (alive) setState({ key: scopeKey, status: "ready", stats, error: null }); },
      (error) => { if (alive) setState({ key: scopeKey, status: "error", stats: null, error: error.message }); },
    );
    return () => { alive = false; };
  }, [allowed, project.id, apiId, stage, range, scopeKey]);

  const apiOptions = useMemo(() => {
    const options = [{ value: ALL, label: "All APIs" }, ...scopeOptions.apis.map((api) => ({ value: api.id, label: api.name }))];
    if (apiId && !options.some((option) => option.value === apiId)) options.push({ value: apiId, label: apiId });
    return options;
  }, [scopeOptions.apis, apiId]);

  const stageOptions = useMemo(() => {
    const names = apiId
      ? scopeOptions.stagesByApi[apiId] ?? []
      : [...new Set(Object.values(scopeOptions.stagesByApi).flat())].sort();
    const options = [{ value: ALL, label: "All stages" }, ...names.map((name) => ({ value: name, label: name }))];
    if (stage && !names.includes(stage)) options.push({ value: stage, label: stage });
    return options;
  }, [scopeOptions.stagesByApi, apiId, stage]);

  const changeApi = (picked) => {
    const value = picked === ALL ? "" : picked;
    setApiId(value);
    // A stage the newly picked API doesn't have would silently zero every chart.
    if (value && stage && !(scopeOptions.stagesByApi[value] ?? []).includes(stage)) setStage("");
  };

  const rangeMeta = RANGES[range];
  const loading = state.key !== scopeKey;
  const refreshButton = <Button variant="outline" className={SECONDARY} onClick={() => setNonce((value) => value + 1)} disabled={loading}>
    <RefreshCw className="h-4 w-4" />Refresh
  </Button>;
  const stageFilter = <FilterDropdown label="Stage" value={stage || ALL} onValueChange={(value) => setStage(value === ALL ? "" : value)} options={stageOptions} height="h-9" />;
  const rangeFilter = <FilterDropdown label="Time range" value={range} onValueChange={setRange} options={RANGE_OPTIONS} height="h-9" />;

  if (!allowed) {
    const denied = <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={LockKeyhole} title="Access unavailable" description="Your current team access does not allow this screen." /></div>;
    return embedded ? denied : <MainScreenWrapper>
      <ScreenHeader title="Monitoring" description="Requests, errors and latency from live gateway traffic." />
      {denied}
    </MainScreenWrapper>;
  }

  const stats = state.stats;
  let body;
  if (loading) {
    body = <LoadingArea label="Loading metrics" />;
  } else if (state.status === "error") {
    body = <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={Activity}
      title="Metrics unavailable"
      description={state.error}
      action={<Button variant="outline" className={SECONDARY} onClick={() => setNonce((value) => value + 1)}>Retry</Button>}
    /></div>;
  } else if (!stats || stats.count === 0) {
    body = <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={Activity}
      title="No traffic in this range"
      description="Metrics appear once the gateway serves requests for this scope. Test-invoke traffic is excluded."
    /></div>;
  } else {
    body = <>
      <StatsBar stats={[
        { label: "Requests", value: stats.count.toLocaleString("en-US"), footer: rangeMeta.label },
        { label: "4XX errors", value: stats.errors4xx.toLocaleString("en-US"), footer: `${pct(stats.errors4xx, stats.count)} of requests` },
        { label: "5XX errors", value: stats.errors5xx.toLocaleString("en-US"), footer: `${pct(stats.errors5xx, stats.count)} of requests` },
        { label: "Latency p90", value: fmtMs(stats.p90), footer: `p99 ${fmtMs(stats.p99)}` },
      ]} />
      <SectionCard title="Traffic" description={`Requests and errors per ${rangeMeta.interval}.`}>
        <MetricChart data={stats.traffic} series={TRAFFIC_SERIES} format={(value) => Number(value).toLocaleString("en-US")} tick={(value) => compact.format(value)} />
      </SectionCard>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SectionCard title="Latency" description={`End-to-end percentiles per ${rangeMeta.interval}, from merged histograms.`}>
          <MetricChart data={stats.latency} series={LATENCY_SERIES} format={fmtMs} tick={(value) => `${compact.format(value)} ms`} />
        </SectionCard>
        <SectionCard title="Latency and cache" description={`Most recent ${rangeMeta.interval} in range.`}>
          <SettingsList>
            <SettingRow title="Latency p50" description="Half of requests finish faster." control={<MetricValue>{fmtMs(stats.p50)}</MetricValue>} />
            <SettingRow title="Latency p90" description="Nine in ten requests finish faster." control={<MetricValue>{fmtMs(stats.p90)}</MetricValue>} />
            <SettingRow title="Latency p99" description="The slowest 1% start here." control={<MetricValue>{fmtMs(stats.p99)}</MetricValue>} />
            <SettingRow title="Integration p90" description="Time spent waiting on the backend." control={<MetricValue>{fmtMs(stats.integrationP90)}</MetricValue>} />
            {stats.cacheHitRatio !== null ? <SettingRow
              title="Cache hit ratio"
              description="Cacheable requests answered from the stage cache (REST only)."
              control={<div className="flex w-28 flex-col items-end gap-1.5">
                <MetricValue>{(stats.cacheHitRatio * 100).toFixed(1)}%</MetricValue>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-active">
                  <div className="h-full rounded-full bg-emerald-400" style={{ width: `${Math.min(100, stats.cacheHitRatio * 100)}%` }} />
                </div>
              </div>}
            /> : null}
          </SettingsList>
        </SectionCard>
      </div>
    </>;
  }

  if (embedded) {
    return <div className="space-y-6">
      <Toolbar>
        <div className="flex flex-wrap items-center gap-2">{stageFilter}{rangeFilter}</div>
        {refreshButton}
      </Toolbar>
      {body}
    </div>;
  }

  return <MainScreenWrapper>
    <ScreenHeader
      title="Monitoring"
      description="Requests, errors and latency from live gateway traffic. Test-invoke traffic is excluded."
      actions={<>
        <FilterDropdown label="API" value={apiId || ALL} onValueChange={changeApi} options={apiOptions} height="h-9" />
        {stageFilter}
        {rangeFilter}
        {refreshButton}
      </>}
    />
    {body}
  </MainScreenWrapper>;
}

function MetricChart({ data, series, format, tick }) {
  const config = Object.fromEntries(series.map((entry) => [entry.key, { label: entry.label, color: entry.color }]));
  return <ChartContainer config={config} className="aspect-auto h-[280px] w-full">
    <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
      <CartesianGrid vertical={false} stroke={GRID} strokeDasharray="3 3" />
      <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={32} tick={{ fill: TICK, fontSize: 11 }} />
      <YAxis tickLine={false} axisLine={false} width={56} tick={{ fill: TICK, fontSize: 11 }} tickFormatter={tick} />
      <ChartTooltip
        cursor={false}
        content={<ChartTooltipContent
          labelFormatter={(_, payload) => payload?.[0]?.payload?.label}
          formatter={(value, name, item) => <span className="flex w-full items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-muted-foreground">
              <span className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: item.color }} />
              {config[name]?.label ?? name}
            </span>
            <span className="font-mono font-medium tabular-nums text-foreground">{value === null ? "—" : format(value)}</span>
          </span>}
        />}
      />
      <ChartLegend content={<ChartLegendContent />} />
      {series.map((entry) => entry.type === "area"
        ? <Area key={entry.key} dataKey={entry.key} type="monotone" stroke={`var(--color-${entry.key})`} fill={`var(--color-${entry.key})`} fillOpacity={0.08} strokeWidth={2} isAnimationActive={false} />
        : <Line key={entry.key} dataKey={entry.key} type="monotone" stroke={`var(--color-${entry.key})`} strokeWidth={entry.dashed ? 1.5 : 2} strokeDasharray={entry.dashed ? "4 3" : undefined} dot={false} connectNulls isAnimationActive={false} />)}
    </ComposedChart>
  </ChartContainer>;
}

function MetricValue({ children }) {
  return <span className="font-mono text-sm text-foreground tabular-nums">{children}</span>;
}

function pct(part, total) {
  if (!total) return "0%";
  return `${((part / total) * 100).toFixed(1)}%`;
}

function fmtMs(value) {
  if (value === null || value === undefined) return "—";
  return `${Number(value).toFixed(1)} ms`;
}
