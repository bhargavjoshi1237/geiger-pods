"use client";

// Project Overview dashboard (layout mirrors geiger-events' Events Overview):
// workspace summary, period stats, traffic trend, traffic by API, request
// outcomes, availability and cache gauges, top APIs and an attention list.
// Live numbers come from `GET /metrics?view=dashboard` plus the API, alarm and
// API-key lists. The landing playground (memory nav) shows sample data instead.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BellRing,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Gauge,
  Hourglass,
  Network,
  PieChart as PieChartIcon,
  TrendingDown,
} from "lucide-react";
import {
  CartesianGrid,
  Label,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  RadialBar,
  RadialBarChart,
  XAxis,
} from "recharts";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Card, CardContent } from "@geiger/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@geiger/ui/chart";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@geiger/ui/dropdown-menu";
import { EmptyState, RollingNumber } from "@geiger/ui/screen-kit";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@geiger/ui/table";
import { cn } from "@geiger/ui/lib/utils";
import { useProject } from "@/context/project-context";
import { useWorkspaceNav, WorkspaceLink } from "@/context/workspace-nav-context";
import FilterDropdown from "./filter_dropdown";
import {
  DASHBOARD_DAYS,
  DEMO_ALARMS,
  DEMO_API_KEY_COUNT,
  DEMO_APIS,
  buildApiRows,
  buildAttention,
  buildDemoDashboard,
  buildStats,
  dayLabel,
  formatCount,
  formatLatency,
  scopeDaily,
  scopeTotals,
  trafficMix,
} from "./overview_data.mjs";

// Theme-aware chart colors: the foreground ramp reads in light and dark.
const INK = "var(--foreground)";
const GRID = "var(--border)";
const TICK = "var(--text-tertiary)";
const CARD = "var(--surface-subtle)";
const SERIES = [100, 74, 54, 38, 26, 18].map((pct) => `color-mix(in srgb, var(--foreground) ${pct}%, var(--surface-subtle))`);

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

const TREND_METRICS = [
  { value: "requests", label: "Requests" },
  { value: "errors", label: "Errors" },
  { value: "throttled", label: "Throttled" },
];

const SORT_OPTIONS = [
  { value: "requests", label: "Requests" },
  { value: "errorRate", label: "Error rate" },
  { value: "latency", label: "Latency" },
];

const HEALTH_META = {
  healthy: { label: "Healthy", icon: CheckCircle2, className: "text-emerald-400" },
  degraded: { label: "Degraded", icon: TrendingDown, className: "text-amber-400" },
  failing: { label: "Failing", icon: AlertTriangle, className: "text-red-400" },
  idle: { label: "No traffic", icon: CircleSlash, className: "text-text-secondary" },
};

const ATTENTION_ICONS = { alarms: BellRing, failing: AlertTriangle, degraded: TrendingDown, throttled: Gauge, idle: CircleSlash, waiting: Hourglass };
const URGENCY_ORDER = ["urgent", "soon", "routine"];
const URGENCY_LABELS = { urgent: "Urgent", soon: "Soon", routine: "Routine" };
const PROTOCOL_LABELS = { REST: "REST", HTTP: "HTTP", WEBSOCKET: "WebSocket" };
const ENDPOINT_LABELS = { REGIONAL: "Regional", EDGE: "Edge", PRIVATE: "Private" };

function emptyDashboard() {
  const today = Math.floor(Date.now() / 86400000) * 86400000;
  const daily = Array.from({ length: DASHBOARD_DAYS }, (_, index) => ({
    day: new Date(today - (DASHBOARD_DAYS - 1 - index) * 86400000).toISOString(), requests: 0, errors: 0, throttled: 0,
  }));
  return { days: DASHBOARD_DAYS, current: {}, previous: {}, daily, apis: [] };
}

async function getJson(projectId, path) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}${path}`, { headers: { "content-type": "application/json" } });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

function useOverviewData(demo, projectId) {
  const [state, setState] = useState(() => demo
    ? { pending: false, apis: DEMO_APIS, dashboard: buildDemoDashboard(), alarms: DEMO_ALARMS, apiKeyCount: DEMO_API_KEY_COUNT, metricsError: null }
    : { pending: true, apis: [], dashboard: null, alarms: [], apiKeyCount: null, metricsError: null });

  useEffect(() => {
    if (demo || !projectId) return undefined;
    let alive = true;
    Promise.allSettled([
      getJson(projectId, "/apis?limit=100"),
      getJson(projectId, `/metrics?view=dashboard&days=${DASHBOARD_DAYS}`),
      getJson(projectId, "/alarms"),
      getJson(projectId, "/api-keys"),
    ]).then(([apis, dashboard, alarms, keys]) => {
      if (!alive) return;
      setState({
        pending: false,
        apis: apis.value?.items ?? [],
        dashboard: dashboard.value ?? null,
        alarms: alarms.value?.items ?? [],
        // API keys need key-management access; without it the count is unknown, not zero.
        apiKeyCount: keys.status === "fulfilled" ? (keys.value?.items?.length ?? 0) : null,
        metricsError: dashboard.status === "rejected" ? dashboard.reason?.message ?? "Metrics unavailable." : null,
      });
    });
    return () => { alive = false; };
  }, [demo, projectId]);

  return state;
}

function WidgetShell({ children, className, contentClassName }) {
  return <Card className={cn("h-full gap-0 overflow-hidden rounded-xl border-border bg-surface-subtle py-0 text-foreground", className)}>
    <CardContent className={cn("h-full p-4", contentClassName)}>{children}</CardContent>
  </Card>;
}

function WidgetHeader({ title, subtitle, action }) {
  return <div className="flex w-full items-start justify-between gap-3">
    <div className="flex min-w-0 flex-1 flex-col">
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      <p className="text-sm text-muted-foreground">{subtitle}</p>
    </div>
    {action}
  </div>;
}

function ApiScopeSelect({ rows, selected, onChange }) {
  const clip = (text) => (text.length > 8 ? `${text.slice(0, 8)}…` : text);
  const label = selected.length === 0
    ? "All"
    : selected.length === 1 ? clip(rows.find((row) => row.id === selected[0])?.name ?? "1 API") : `${selected.length} APIs`;
  const toggle = (id) => onChange(selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]);
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="outline" aria-label="Filter by API" disabled={!rows.length} className="h-9 gap-2 border-border bg-surface-card text-xs text-foreground hover:bg-surface-active">
        <Network className="size-4 text-muted-foreground" />
        <span className="max-w-[120px] truncate">{label}</span>
        <ChevronDown className="size-4 text-muted-foreground" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="max-h-72 w-56 overflow-y-auto border-border bg-surface-subtle">
      <DropdownMenuCheckboxItem checked={selected.length === 0} onCheckedChange={() => onChange([])} onSelect={(event) => event.preventDefault()}>All APIs</DropdownMenuCheckboxItem>
      <DropdownMenuSeparator className="bg-border" />
      {rows.map((row) => <DropdownMenuCheckboxItem key={row.id} checked={selected.includes(row.id)} onCheckedChange={() => toggle(row.id)} onSelect={(event) => event.preventDefault()}>
        <span className="truncate">{row.name}</span>
      </DropdownMenuCheckboxItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}

// StatsBar layout with tone separate from direction: more errors is an arrow up, in red.
function OverviewStats({ stats }) {
  return <Card className="gap-0 overflow-hidden rounded-xl border-border bg-surface-subtle py-0 text-foreground">
    <CardContent className="p-0">
      <div className="grid grid-cols-2 md:grid-cols-4">
        {stats.map((stat, index) => {
          const Arrow = stat.direction === "down" ? ArrowDownRight : ArrowUpRight;
          return <div key={stat.label} className={cn("border-border p-4", index % 2 !== 0 && "border-l", index >= 2 && "border-t", "md:border-t-0 md:border-l-0", index > 0 && "md:border-l")}>
            <span className="text-[11px] font-medium uppercase tracking-wider text-text-secondary">{stat.label}</span>
            <div className="mt-1 flex flex-col items-start gap-1 sm:flex-row sm:items-end sm:gap-2">
              <RollingNumber value={stat.value} className="text-2xl font-bold leading-none text-foreground" />
              {stat.delta ? <span className={cn("inline-flex items-center gap-0.5 text-xs font-medium sm:mb-0.5", stat.tone === "good" && "text-emerald-400", stat.tone === "bad" && "text-red-400", stat.tone === "neutral" && "text-text-secondary")}>
                <Arrow className="size-3" />{stat.delta}
              </span> : null}
            </div>
            <span className="mt-1 block text-[11px] text-text-tertiary">{stat.footer}</span>
          </div>;
        })}
      </div>
    </CardContent>
  </Card>;
}

function TrafficTrendWidget({ pending, dashboard, rows }) {
  const [metric, setMetric] = useState("requests");
  const [scope, setScope] = useState([]);
  const selected = TREND_METRICS.find((option) => option.value === metric);
  const data = useMemo(() => scopeDaily(dashboard, scope).map((cell) => ({ label: dayLabel(cell.day), value: cell[metric] ?? 0 })), [dashboard, scope, metric]);
  const hasTraffic = (dashboard.daily ?? []).some((cell) => cell.requests > 0);
  const action = <div className="flex items-center gap-2">
    <ApiScopeSelect rows={rows} selected={scope} onChange={setScope} />
    <FilterDropdown label="Trend metric" value={metric} onValueChange={setMetric} options={TREND_METRICS} />
  </div>;

  // While the fetch is in flight the series is all zeros, so the line sits on
  // the baseline and rises when the real numbers land.
  if (!pending && !hasTraffic) {
    return <WidgetShell contentClassName="flex flex-col">
      <WidgetHeader title="Traffic Over Time" subtitle={`${selected.label} per day across your APIs.`} action={action} />
      <div className="mt-4 flex min-h-0 flex-1 items-center justify-center">
        <EmptyState icon={Activity} title="No traffic yet" description="Requests show up here once a deployed stage starts serving traffic." />
      </div>
    </WidgetShell>;
  }

  return <WidgetShell contentClassName="flex flex-col">
    <WidgetHeader title="Traffic Over Time" subtitle={`${selected.label} per day across your APIs.`} action={action} />
    <div className="mt-4 flex min-h-0 flex-1 items-center justify-center">
      <ChartContainer config={{ value: { label: selected.label, color: INK } }} className="mx-auto h-full w-full">
        <LineChart data={data} margin={{ top: 24, right: 16, left: 12, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID} strokeDasharray="3 3" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} tick={{ fill: TICK, fontSize: 11 }} />
          <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" hideLabel formatter={(value) => <span className="font-medium tabular-nums text-foreground">{formatCount(value)}</span>} />} />
          <Line dataKey="value" type="monotone" stroke={INK} strokeWidth={2} dot={{ fill: INK, r: 3 }} activeDot={{ r: 5 }}>
            <LabelList dataKey="value" position="top" offset={10} fill={INK} fontSize={11} formatter={(value) => compact.format(value)} />
          </Line>
        </LineChart>
      </ChartContainer>
    </div>
  </WidgetShell>;
}

function TrafficMixWidget({ pending, rows }) {
  const mix = useMemo(() => trafficMix(rows), [rows]);
  const [picked, setPicked] = useState(null);
  const activeKey = mix.some((item) => item.key === picked) ? picked : mix[0]?.key ?? null;
  const total = mix.reduce((sum, item) => sum + item.value, 0);
  const chartData = mix.map((item, index) => ({ ...item, fill: SERIES[index % SERIES.length] }));
  const activeIndex = Math.max(chartData.findIndex((item) => item.key === activeKey), 0);
  const active = chartData[activeIndex];
  const config = Object.fromEntries(mix.map((item, index) => [item.key, { label: item.label, color: SERIES[index % SERIES.length] }]));

  // A donut has no zero shape, so mid-fetch it holds an empty ring on the same geometry.
  if (pending && !mix.length) {
    return <WidgetShell contentClassName="flex flex-col">
      <WidgetHeader title="Traffic by API" subtitle="Share of requests per API." />
      <div className="relative mt-4 flex min-h-0 w-full flex-1 items-center justify-center">
        <div className="size-[156px] rounded-full border-[34px] border-border" />
        <div className="pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center">
          <span className="text-3xl font-bold leading-none text-foreground">0</span>
          <span className="mt-1 text-xs font-medium text-muted-foreground">0% share</span>
        </div>
      </div>
      <p className="mt-2 text-center text-xs text-text-secondary">0 of 0 requests</p>
    </WidgetShell>;
  }

  if (!mix.length) {
    return <WidgetShell contentClassName="flex flex-col">
      <WidgetHeader title="Traffic by API" subtitle="Share of requests per API." />
      <div className="mt-4 flex min-h-0 flex-1 items-center justify-center">
        <EmptyState icon={PieChartIcon} title="No requests yet" description="Serve traffic from an API to see how it splits." />
      </div>
    </WidgetShell>;
  }

  return <WidgetShell contentClassName="flex flex-col">
    <WidgetHeader title="Traffic by API" subtitle="Share of requests per API." action={<FilterDropdown label="Highlighted API" value={activeKey} onValueChange={setPicked} options={mix.map((item) => ({ value: item.key, label: item.label }))} />} />
    <div className="relative mt-4 flex min-h-0 w-full flex-1 items-center justify-center">
      <ChartContainer config={config} className="mx-auto h-[220px] w-[220px]">
        <PieChart>
          <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel nameKey="key" />} />
          <Pie data={chartData} dataKey="value" nameKey="key" cx="50%" cy="50%" innerRadius={44} outerRadius={78} activeIndex={activeIndex} activeShape={{ outerRadius: 88 }} stroke={CARD} strokeWidth={2} />
        </PieChart>
      </ChartContainer>
      <div className="pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center">
        <span className="text-2xl font-bold leading-none text-foreground">{compact.format(active?.value ?? 0)}</span>
        <span className="mt-1 text-xs font-medium text-muted-foreground">{total > 0 ? Math.round(((active?.value ?? 0) / total) * 100) : 0}% share</span>
      </div>
    </div>
    <p className="mt-2 truncate text-center text-xs text-text-secondary">{active?.label}: {formatCount(active?.value)} of {formatCount(total)} requests</p>
  </WidgetShell>;
}

function OutcomesWidget({ totals }) {
  const requests = totals.requests ?? 0;
  const errors4xx = totals.errors4xx ?? 0;
  const errors5xx = totals.errors5xx ?? 0;
  const succeeded = Math.max(requests - errors4xx - errors5xx, 0);
  const share = (value) => (requests > 0 ? Math.round((value / requests) * 100) : 0);
  const data = [
    { key: "success", short: "Succeeded", label: "2XX / 3XX responses", value: succeeded },
    { key: "4xx", short: "4XX", label: "Client errors", value: errors4xx },
    { key: "5xx", short: "5XX", label: "Server errors", value: errors5xx },
    { key: "throttled", short: "Throttled", label: "Throttled or over quota", value: totals.throttled ?? 0 },
    { key: "cached", short: "Cached", label: "Served from cache", value: totals.cacheHits ?? 0 },
  ].map((item) => ({ ...item, share: share(item.value) }));

  return <WidgetShell contentClassName="flex flex-col">
    <WidgetHeader
      title="Request Outcomes"
      subtitle="Share of requests by how the gateway answered."
      action={<div className="flex shrink-0 flex-col items-end">
        <span className="text-3xl font-bold leading-none text-foreground">{share(succeeded)}%</span>
        <span className="mt-1 text-[11px] text-text-secondary">succeeded</span>
      </div>}
    />
    <div className="mt-1 flex min-h-0 flex-1 items-center justify-center">
      <ChartContainer config={{ share: { label: "Share of requests", color: INK } }} className="mx-auto aspect-square h-full max-h-[210px]">
        <RadarChart data={data} margin={{ top: 8, right: 28, bottom: 8, left: 28 }}>
          <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel nameKey="key" formatter={(value, name, item) => <span className="flex w-full items-center justify-between gap-3">
            <span className="text-muted-foreground">{item.payload.label}</span>
            <span className="font-medium tabular-nums text-foreground">{formatCount(item.payload.value)} · {item.payload.share}%</span>
          </span>} />} />
          <PolarGrid stroke={GRID} />
          <PolarAngleAxis dataKey="short" tick={{ fill: TICK, fontSize: 11 }} />
          <Radar dataKey="share" stroke={INK} strokeWidth={2} fill={INK} fillOpacity={0.35} dot={{ r: 4, fill: INK, fillOpacity: 1, stroke: CARD, strokeWidth: 1.5 }} />
        </RadarChart>
      </ChartContainer>
    </div>
  </WidgetShell>;
}

function GaugeWidget({ title, subtitle, caption, rows, compute }) {
  const [scope, setScope] = useState([]);
  const { pct, footnote } = useMemo(() => compute(scope), [compute, scope]);
  const clamped = Math.max(0, Math.min(100, pct));
  const data = [{ name: caption, value: clamped, fill: INK }];
  return <WidgetShell contentClassName="flex flex-col">
    <WidgetHeader title={title} subtitle={subtitle} action={<ApiScopeSelect rows={rows} selected={scope} onChange={setScope} />} />
    <div className="mt-1 flex min-h-0 flex-1 items-center justify-center">
      <ChartContainer config={{ value: { label: caption, color: INK } }} className="mx-auto aspect-square h-full max-h-[190px]">
        <RadialBarChart data={data} startAngle={90} endAngle={90 - (clamped / 100) * 360} innerRadius={72} outerRadius={104}>
          <PolarGrid gridType="circle" radialLines={false} stroke="none" polarRadius={[78, 66]} className="first:fill-surface-card last:fill-surface-subtle" />
          <RadialBar dataKey="value" cornerRadius={8} />
          <PolarRadiusAxis tick={false} tickLine={false} axisLine={false}>
            <Label content={({ viewBox }) => (viewBox && "cx" in viewBox && "cy" in viewBox ? <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
              <tspan x={viewBox.cx} y={viewBox.cy} className="fill-foreground text-3xl font-bold">{clamped}%</tspan>
              <tspan x={viewBox.cx} y={(viewBox.cy || 0) + 22} className="fill-muted-foreground text-xs font-medium">{caption}</tspan>
            </text> : null)} />
          </PolarRadiusAxis>
        </RadialBarChart>
      </ChartContainer>
    </div>
    {footnote ? <p className="mt-1 text-center text-xs text-text-secondary">{footnote}</p> : null}
  </WidgetShell>;
}

function TopApisTable({ demo, pending, rows }) {
  const [sortBy, setSortBy] = useState("requests");
  const [scope, setScope] = useState([]);
  const sorted = useMemo(() => {
    const scoped = scope.length ? rows.filter((row) => scope.includes(row.id)) : rows;
    const key = { requests: (row) => row.requests, errorRate: (row) => row.errorRate, latency: (row) => row.p90LatencyMs ?? -1 }[sortBy];
    return [...scoped].sort((a, b) => key(b) - key(a)).slice(0, 5);
  }, [rows, scope, sortBy]);

  return <div className="flex flex-col gap-4">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <WidgetHeader title="Top APIs" subtitle={`Ranked by traffic, errors and latency over the last ${DASHBOARD_DAYS} days.`} />
      <div className="flex items-center gap-2">
        <ApiScopeSelect rows={rows} selected={scope} onChange={setScope} />
        <FilterDropdown label="Sort APIs by" value={sortBy} onValueChange={setSortBy} options={SORT_OPTIONS} />
      </div>
    </div>
    <div className="overflow-hidden rounded-2xl border border-border bg-surface-card">
      {/* Mid-fetch the table keeps its header and no rows rather than declaring the project empty. */}
      {sorted.length === 0 && !pending
        ? <EmptyState icon={Network} title="No APIs yet" description="Create an API to see it ranked here." action={<Button asChild variant="outline" size="sm"><WorkspaceLink section="apis">Open APIs</WorkspaceLink></Button>} />
        : <Table>
          <TableHeader>
            <TableRow className="border-border">
              <TableHead>API</TableHead>
              <TableHead>Protocol</TableHead>
              <TableHead className="w-[180px]">Error rate</TableHead>
              <TableHead className="text-right">Requests</TableHead>
              <TableHead className="text-right">p90</TableHead>
              <TableHead>Health</TableHead>
              <TableHead className="text-right"><span className="sr-only">Open</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((row) => {
              const pct = Math.round(row.errorRate * 1000) / 10;
              const meta = HEALTH_META[row.health];
              const HealthIcon = meta.icon;
              return <TableRow key={row.id} className="border-border">
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <span className="font-medium text-foreground">{row.name}</span>
                    <span className="text-xs text-text-secondary">{ENDPOINT_LABELS[row.endpointType] ?? row.endpointType} endpoint</span>
                  </div>
                </TableCell>
                <TableCell><Badge variant="outline">{PROTOCOL_LABELS[row.protocol] ?? row.protocol}</Badge></TableCell>
                <TableCell>
                  <div className="w-[140px] space-y-1.5">
                    <div className="h-1.5 overflow-hidden rounded-full bg-surface-hover"><div className="h-full rounded-full bg-foreground" style={{ width: `${Math.min(100, pct)}%` }} /></div>
                    <p className="text-xs text-text-secondary">{row.requests > 0 ? `${pct}%` : "—"}</p>
                  </div>
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums text-foreground">{formatCount(row.requests)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{formatLatency(row.p90LatencyMs)}</TableCell>
                <TableCell><span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap font-medium", meta.className)}><HealthIcon className="size-3.5" />{meta.label}</span></TableCell>
                <TableCell className="text-right">
                  <Button asChild variant="ghost" size="sm" className="text-muted-foreground hover:bg-surface-active hover:text-foreground">
                    <WorkspaceLink section={demo ? "apis" : `apis/${encodeURIComponent(row.ref)}`} aria-label={`Open ${row.name}`}><ArrowUpRight className="size-4" /></WorkspaceLink>
                  </Button>
                </TableCell>
              </TableRow>;
            })}
          </TableBody>
        </Table>}
    </div>
  </div>;
}

function AttentionCard({ demo, items }) {
  const sorted = [...items].sort((a, b) => URGENCY_ORDER.indexOf(a.urgency) - URGENCY_ORDER.indexOf(b.urgency));
  const open = items.filter((item) => item.count > 0).length;
  return <WidgetShell contentClassName="flex flex-col">
    <WidgetHeader
      title="Needs Attention"
      subtitle="Alarms, unhealthy APIs and limits across this project."
      action={<span className="shrink-0 rounded-md border border-border bg-surface-card px-2 py-0.5 text-[10px] font-medium text-muted-foreground">{open} open</span>}
    />
    <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {sorted.map((item) => {
        const Icon = ATTENTION_ICONS[item.key];
        // The playground's in-memory nav only knows top-level sections.
        const section = demo ? item.section.split("/")[0] : item.section;
        return <WorkspaceLink key={item.key} section={section} className="group flex items-center gap-3.5 rounded-xl p-3.5 text-left transition-colors hover:bg-surface-card">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-card text-muted-foreground"><Icon className="size-[18px]" /></div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-foreground">{item.label}</span>
              <span className="shrink-0 rounded-md border border-border bg-surface-card px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">{URGENCY_LABELS[item.urgency]}</span>
            </div>
            <p className="mt-0.5 truncate text-xs text-text-secondary">{item.hint}</p>
          </div>
          <span className={cn("shrink-0 text-xl font-bold tabular-nums", item.count > 0 ? "text-foreground" : "text-text-tertiary")}>{formatCount(item.count)}</span>
          <ChevronRight className="size-3 shrink-0 text-text-secondary transition-colors group-hover:text-foreground" />
        </WorkspaceLink>;
      })}
    </div>
  </WidgetShell>;
}

export function PodsOverview() {
  const { project } = useProject();
  const { memory: demo } = useWorkspaceNav();
  const { pending, apis, dashboard: loaded, alarms, apiKeyCount, metricsError } = useOverviewData(demo, project.id);
  const dashboard = loaded ?? emptyDashboard();

  const rows = useMemo(() => buildApiRows(apis, dashboard), [apis, dashboard]);
  const stats = useMemo(() => buildStats(dashboard), [dashboard]);
  const attention = useMemo(() => buildAttention({ alarms, rows, dashboard }), [alarms, rows, dashboard]);
  const summary = [
    { label: "APIs", value: formatCount(apis.length) },
    { label: "API Keys", value: apiKeyCount === null ? "—" : formatCount(apiKeyCount) },
    { label: "In Alarm", value: formatCount(alarms.filter((alarm) => alarm.state === "ALARM").length) },
  ];

  const availability = useCallback((scope) => {
    const totals = scopeTotals(dashboard, scope);
    const requests = totals.requests ?? 0;
    if (requests === 0) return { pct: 0, footnote: "No requests yet" };
    const ok = requests - (totals.errors5xx ?? 0);
    return { pct: Math.floor((ok / requests) * 1000) / 10, footnote: `${formatCount(ok)} of ${formatCount(requests)} without a 5XX` };
  }, [dashboard]);

  const cacheRate = useCallback((scope) => {
    const totals = scopeTotals(dashboard, scope);
    const lookups = (totals.cacheHits ?? 0) + (totals.cacheMisses ?? 0);
    if (lookups === 0) return { pct: 0, footnote: "No cache lookups yet" };
    return { pct: Math.round(((totals.cacheHits ?? 0) / lookups) * 100), footnote: `${formatCount(totals.cacheHits)} of ${formatCount(lookups)} lookups` };
  }, [dashboard]);

  return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
    <div className="mt-2 flex flex-col justify-between gap-4 md:flex-row md:items-center">
      <div>
        <h1 className="text-center text-2xl font-bold tracking-tight text-foreground md:text-left">Pods Overview</h1>
        <p className="mt-1 text-center text-sm text-muted-foreground md:text-left">Track traffic, errors, latency and throttling across every API in {project.name}.</p>
      </div>
      <div className="flex w-full md:w-auto">
        {summary.map((stat, index) => <div key={stat.label} className={cn("flex flex-1 flex-col items-center md:flex-none", index > 0 && "border-l border-border", index === 0 ? "md:pr-8" : index === summary.length - 1 ? "md:pl-8" : "md:px-8")}>
          <span className="text-[11px] font-medium uppercase tracking-wider text-text-secondary">{stat.label}</span>
          <RollingNumber value={stat.value} className="mt-0.5 text-2xl font-bold text-foreground" />
        </div>)}
      </div>
    </div>

    <div className="space-y-2">
      <OverviewStats stats={stats} />
      {metricsError ? <p className="text-xs text-text-secondary">Traffic metrics are unavailable: {metricsError}</p> : null}
    </div>

    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="h-[360px] lg:col-span-2"><TrafficTrendWidget pending={pending} dashboard={dashboard} rows={rows} /></div>
      <div className="h-[360px]"><TrafficMixWidget pending={pending} rows={rows} /></div>
    </div>

    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <div className="h-[300px]"><OutcomesWidget totals={dashboard.current ?? {}} /></div>
      <div className="h-[300px]"><GaugeWidget title="Availability" subtitle="Requests answered without a 5XX." caption="Available" rows={rows} compute={availability} /></div>
      <div className="h-[300px]"><GaugeWidget title="Cache Hit Rate" subtitle="Stage cache hits vs. lookups." caption="Hits" rows={rows} compute={cacheRate} /></div>
    </div>

    <TopApisTable demo={demo} pending={pending} rows={rows} />

    <AttentionCard demo={demo} items={attention} />
  </div>;
}
