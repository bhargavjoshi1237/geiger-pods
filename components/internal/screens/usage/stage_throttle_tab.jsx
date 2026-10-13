"use client";

import { useCallback, useEffect, useState } from "react";
import { Gauge, Loader2 } from "lucide-react";
import { EmptyState, Field, LoadingArea, SectionCard } from "@/components/internal/shared/screen_kit";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Textarea } from "@geiger/ui/textarea";
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

const pickThrottle = (entry) => (entry == null ? null : {
  rateLimit: entry.rateLimit ?? entry.throttlingRateLimit ?? null,
  burstLimit: entry.burstLimit ?? entry.throttlingBurstLimit ?? null,
});

const asText = (value) => (value === null || value === undefined ? "" : String(value));

// The throttle endpoint answers { defaultThrottle, throttles }; the raw stage
// shape (method/route settings) is still read for older responses.
function toForm(data, rest) {
  const current = data.defaultThrottle !== undefined
    ? data.defaultThrottle
    : rest ? data.methodSettings?.["*/*"] : data.defaultRouteSettings;
  const overrides = data.throttles ?? (rest ? data.methodSettings : data.routeSettings) ?? {};
  const fallback = pickThrottle(current);
  const pairs = Object.entries(overrides).filter(([key]) => key !== "*/*");
  return {
    rate: asText(fallback?.rateLimit),
    burst: asText(fallback?.burstLimit),
    overrides: JSON.stringify(Object.fromEntries(pairs.map(([key, entry]) => [key, pickThrottle(entry)])), null, 2),
  };
}

function parseLimit(text) {
  const value = Number(text);
  return text.trim() !== "" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Stage throttling, embedded in the API editor's stage detail: the stage
 * default rate/burst plus per-method (REST "/path/METHOD") or per-route
 * (HTTP/WebSocket) overrides, validated against the project throttle.
 */
export function StageThrottleTab({ api, stage }) {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", data: null, error: null });
  const [form, setForm] = useState({ rate: "", burst: "", overrides: "{}" });
  const [busy, setBusy] = useState(false);
  const writable = can("pods.stage.write");
  const rest = api.protocol === "REST";
  const apiRef = api.id ?? api.publicId;
  const path = `/stages/${encodeURIComponent(stage.name)}/throttle`;

  const apply = useCallback((data) => {
    setState({ status: "ready", data, error: null });
    setForm(toForm(data, rest));
  }, [rest]);

  const load = useCallback(async () => {
    try {
      apply(await call(project.id, apiRef, path));
    } catch (error) {
      setState({ status: "error", data: null, error: error.message });
    }
  }, [project.id, apiRef, path, apply]);

  useEffect(() => {
    let alive = true;
    call(project.id, apiRef, path).then(
      (data) => { if (alive) apply(data); },
      (error) => { if (alive) setState({ status: "error", data: null, error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id, apiRef, path, apply]);

  const set = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));

  const save = async () => {
    let defaultThrottle = null;
    if (form.rate.trim() !== "" || form.burst.trim() !== "") {
      const rateLimit = parseLimit(form.rate);
      const burstLimit = parseLimit(form.burst);
      if (rateLimit === null || burstLimit === null) {
        toast.error("Set both rate and burst to numbers of 0 or more, or leave both empty.");
        return;
      }
      defaultThrottle = { rateLimit, burstLimit };
    }
    let throttles = {};
    try {
      throttles = form.overrides.trim() === "" ? {} : JSON.parse(form.overrides);
    } catch {
      toast.error("Overrides must be valid JSON.");
      return;
    }
    setBusy(true);
    try {
      await call(project.id, apiRef, path, {
        method: "PUT",
        headers: { "If-Match": String(state.data.version) },
        body: JSON.stringify({ defaultThrottle, throttles }),
      });
      toast.success("Throttling saved. Gateways apply it within a minute.");
      await load();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  if (state.status === "loading") return <LoadingArea panel label="Loading stage throttling" />;
  if (state.status === "error") {
    return <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={Gauge}
      title="Throttling unavailable"
      description={state.error}
      action={<Button variant="outline" onClick={() => { setState({ status: "loading", data: null, error: null }); load(); }}>Retry</Button>}
    /></div>;
  }

  const fieldId = `stage-throttle-${stage.name}`;
  return <SectionCard
    bare
    title="Throttling"
    description="Stage-wide limits plus per-method or per-route overrides. Values can't exceed the project throttle; a rate or burst of 0 blocks all traffic."
    action={writable ? <Button size="sm" className="bg-primary text-primary-foreground hover:bg-primary/90" disabled={busy} onClick={save}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Save Throttling
    </Button> : null}
  >
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Default rate (requests/sec)" htmlFor={`${fieldId}-rate`}>
          <Input id={`${fieldId}-rate`} value={form.rate} onChange={set("rate")} inputMode="decimal" placeholder="No default" readOnly={!writable} />
        </Field>
        <Field label="Default burst" htmlFor={`${fieldId}-burst`}>
          <Input id={`${fieldId}-burst`} value={form.burst} onChange={set("burst")} inputMode="numeric" placeholder="No default" readOnly={!writable} />
        </Field>
      </div>
      <Field
        label={rest ? "Method overrides (JSON)" : "Route overrides (JSON)"}
        htmlFor={`${fieldId}-overrides`}
        hint={rest
          ? 'Keys are "/path/METHOD", values {"rateLimit", "burstLimit"}. Up to 20.'
          : 'Keys are route keys, values {"rateLimit", "burstLimit"}. Up to 20.'}
      >
        <Textarea
          id={`${fieldId}-overrides`}
          className="min-h-28 font-mono text-xs"
          value={form.overrides}
          onChange={set("overrides")}
          spellCheck={false}
          readOnly={!writable}
        />
      </Field>
    </div>
  </SectionCard>;
}

/**
 * Project-level (account) throttle card: the ceiling every plan and stage
 * throttle is validated against.
 */
export function ProjectThrottleCard({ settings, onSave, canSave, busy }) {
  const [rate, setRate] = useState(String(settings?.throttleRate ?? 10000));
  const [burst, setBurst] = useState(String(settings?.throttleBurst ?? 5000));
  return <SectionCard
    title="Project throttle"
    description="The account-wide token bucket (10,000 rps / 5,000 burst by default). Plan and stage throttles can't exceed it."
    action={canSave ? <Button
      size="sm"
      className="bg-primary text-primary-foreground hover:bg-primary/90"
      disabled={busy}
      onClick={() => onSave({ throttleRate: Number(rate), throttleBurst: Number(burst) })}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Save Throttle
    </Button> : null}
  >
    <div className="grid grid-cols-2 gap-4">
      <Field label="Rate (requests/sec)" htmlFor="project-throttle-rate">
        <Input id="project-throttle-rate" value={rate} onChange={(event) => setRate(event.target.value)} inputMode="numeric" readOnly={!canSave} />
      </Field>
      <Field label="Burst" htmlFor="project-throttle-burst">
        <Input id="project-throttle-burst" value={burst} onChange={(event) => setBurst(event.target.value)} inputMode="numeric" readOnly={!canSave} />
      </Field>
    </div>
  </SectionCard>;
}
