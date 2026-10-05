"use client";

import { useCallback, useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import { EmptyState, SectionCard } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
import { Label } from "@geiger/ui/label";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";

async function call(projectId, apiId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/apis/${encodeURIComponent(apiId)}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

/**
 * Stage throttling tab (S08 §7, embedded in the S05 stage detail by the
 * orchestrator): default rate/burst plus per-method (REST "/path/METHOD",
 * star-slash-star default) or per-route (HTTP/WebSocket) overrides, validated
 * against the project throttle. Standalone export; navigation wiring is the
 * orchestrator's.
 */
export function StageThrottleTab({ api, stage }) {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", data: null, error: null });
  const [defaultText, setDefaultText] = useState("null");
  const [throttlesText, setThrottlesText] = useState("{}");
  const [busy, setBusy] = useState(false);

  const apiRef = api.id ?? api.publicId;

  const load = useCallback(async () => {
    setState({ status: "loading", data: null, error: null });
    try {
      const data = await call(project.id, apiRef, `/stages/${encodeURIComponent(stage.name)}/throttle`);
      setState({ status: "ready", data, error: null });
      const rest = api.protocol === "REST";
      const current = rest
        ? (data.methodSettings?.["*/*"] ?? null)
        : (data.defaultRouteSettings ?? null);
      setDefaultText(JSON.stringify(current === null ? null : {
        rateLimit: current.throttlingRateLimit ?? current.rateLimit,
        burstLimit: current.throttlingBurstLimit ?? current.burstLimit,
      }));
      const rest2 = rest ? data.methodSettings : data.routeSettings;
      const pairs = Object.entries(rest2 ?? {}).filter(([key]) => key !== "*/*");
      setThrottlesText(JSON.stringify(Object.fromEntries(pairs.map(([key, entry]) => [key, {
        rateLimit: entry.throttlingRateLimit ?? entry.rateLimit,
        burstLimit: entry.throttlingBurstLimit ?? entry.burstLimit,
      }])), null, 2));
    } catch (error) {
      setState({ status: "error", data: null, error: error.message });
    }
  }, [project.id, apiRef, stage.name, api.protocol]);

  useEffect(() => {
    let alive = true;
    call(project.id, apiRef, `/stages/${encodeURIComponent(stage.name)}/throttle`).then(
      (data) => {
        if (!alive) return;
        setState({ status: "ready", data, error: null });
        const rest = api.protocol === "REST";
        const current = rest
          ? (data.methodSettings?.["*/*"] ?? null)
          : (data.defaultRouteSettings ?? null);
        setDefaultText(JSON.stringify(current === null ? null : {
          rateLimit: current.throttlingRateLimit ?? current.rateLimit,
          burstLimit: current.throttlingBurstLimit ?? current.burstLimit,
        }));
        const rest2 = rest ? data.methodSettings : data.routeSettings;
        const pairs = Object.entries(rest2 ?? {}).filter(([key]) => key !== "*/*");
        setThrottlesText(JSON.stringify(Object.fromEntries(pairs.map(([key, entry]) => [key, {
          rateLimit: entry.throttlingRateLimit ?? entry.rateLimit,
          burstLimit: entry.throttlingBurstLimit ?? entry.burstLimit,
        }])), null, 2));
      },
      (error) => { if (alive) setState({ status: "error", data: null, error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id, apiRef, stage.name, api.protocol]);

  const save = async () => {
    let defaultThrottle = null;
    let throttles = {};
    try {
      defaultThrottle = defaultText.trim() === "" || defaultText.trim() === "null" ? null : JSON.parse(defaultText);
      throttles = throttlesText.trim() === "" ? {} : JSON.parse(throttlesText);
    } catch {
      toast.error("Settings must be valid JSON.");
      return;
    }
    setBusy(true);
    try {
      await call(project.id, apiRef, `/stages/${encodeURIComponent(stage.name)}/throttle`, {
        method: "PUT",
        headers: { "If-Match": String(state.data.version) },
        body: JSON.stringify({ defaultThrottle, throttles }),
      });
      toast.success("Stage throttling saved. Runtimes apply it within a minute.");
      load();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  if (state.status === "loading") return <SectionCard><div className="flex justify-center py-6"><LogoLoading /></div></SectionCard>;
  if (state.status === "error") return <SectionCard><EmptyState icon={Gauge} title="Throttling unavailable" description={state.error} action={<Button variant="outline" onClick={load}>Retry</Button>} /></SectionCard>;
  return <SectionCard title={`Throttling — ${stage.name}`} description="Stage defaults and per-method/route overrides. Values may not exceed the project throttle. Rate/burst 0 blocks all traffic.">
    <div className="grid gap-2">
      <Label>Default ({api.protocol === "REST" ? '"*/*"' : "default route settings"}), JSON or null</Label>
      <textarea className="min-h-16 w-full rounded-md border border-input bg-background p-2 font-mono text-xs" value={defaultText} onChange={(event) => setDefaultText(event.target.value)} spellCheck={false} />
      <Label>Overrides ({api.protocol === "REST" ? '"/path/METHOD"' : "route keys"}), JSON object, ≤20</Label>
      <textarea className="min-h-24 w-full rounded-md border border-input bg-background p-2 font-mono text-xs" value={throttlesText} onChange={(event) => setThrottlesText(event.target.value)} spellCheck={false} />
      <div><Button size="sm" disabled={busy || !can("pods.stage.write")} onClick={save}>Save throttling</Button></div>
    </div>
  </SectionCard>;
}

/**
 * Project-level (account) throttle card (S08 §7): the ceiling every plan
 * and stage throttle is validated against. Lives on the S02 project
 * settings screen once the orchestrator wires it.
 */
export function ProjectThrottleCard({ settings, onSave, canSave, busy }) {
  const [rate, setRate] = useState(String(settings?.throttleRate ?? 10000));
  const [burst, setBurst] = useState(String(settings?.throttleBurst ?? 5000));
  return <SectionCard title="Project throttle" description="Account-level token bucket (AWS defaults 10000 rps / 5000 burst). Plan and stage throttles may not exceed it.">
    <div className="grid gap-2">
      <Label htmlFor="s08-proj-rate">Rate (requests/sec)</Label>
      <input id="s08-proj-rate" className="rounded-md border border-input bg-background p-2 text-sm" value={rate} onChange={(event) => setRate(event.target.value)} inputMode="numeric" />
      <Label htmlFor="s08-proj-burst">Burst</Label>
      <input id="s08-proj-burst" className="rounded-md border border-input bg-background p-2 text-sm" value={burst} onChange={(event) => setBurst(event.target.value)} inputMode="numeric" />
      <div><Button size="sm" disabled={busy || !canSave} onClick={() => onSave({ throttleRate: Number(rate), throttleBurst: Number(burst) })}>Save throttle</Button></div>
    </div>
  </SectionCard>;
}
