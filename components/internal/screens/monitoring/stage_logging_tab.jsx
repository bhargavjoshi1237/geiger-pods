"use client";

// Stage → Logs & tracing sub-tab: access-log toggle and format presets with a
// live preview against a sample context, destinations, execution-log level,
// data trace, detailed metrics and the tracing toggle. Rendered inside the
// API editor's stage panel, so it has no screen header of its own.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, FileText, Loader2, LockKeyhole, Microscope, ScrollText, Waypoints } from "lucide-react";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { Switch } from "@geiger/ui/switch";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { EmptyState, Field, LoadingArea, SectionCard, SettingRow, SettingsList } from "@/components/internal/shared/screen_kit";
import { WorkspaceLink } from "@/context/workspace-nav-context";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";

const PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";
const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

const LOG_LEVELS = [
  { value: "OFF", label: "Off" },
  { value: "ERROR", label: "Errors only" },
  { value: "INFO", label: "Info" },
];

const PRESETS = [
  ["CLF", "$context.identity.sourceIp $context.identity.caller $context.identity.user [$context.requestTime] \"$context.httpMethod $context.resourcePath $context.protocol\" $context.status $context.responseLength $context.requestId"],
  ["JSON", "{ \"requestId\":\"$context.requestId\", \"ip\": \"$context.identity.sourceIp\", \"caller\":\"$context.identity.caller\", \"user\":\"$context.identity.user\",\"requestTime\":\"$context.requestTime\", \"httpMethod\":\"$context.httpMethod\",\"resourcePath\":\"$context.resourcePath\", \"status\":\"$context.status\",\"protocol\":\"$context.protocol\", \"responseLength\":\"$context.responseLength\" }"],
];

const SAMPLE = {
  "requestId": "c6af9ac6-7b61-11e6-9a41-93e8deadbeef",
  "ip": "192.0.2.1",
  "caller": "-",
  "user": "-",
  "requestTime": "12/Oct/2026:12:00:00 +0000",
  "httpMethod": "GET",
  "resourcePath": "/pets",
  "status": "200",
  "protocol": "https",
  "responseLength": "142",
};

function previewFormat(format) {
  let out = String(format ?? "");
  out = out.replace(/\$context\.requestId/g, SAMPLE.requestId);
  out = out.replace(/\$context\.identity\.sourceIp/g, SAMPLE.ip);
  out = out.replace(/\$context\.identity\.caller/g, SAMPLE.caller);
  out = out.replace(/\$context\.identity\.user/g, SAMPLE.user);
  out = out.replace(/\$context\.requestTime/g, SAMPLE.requestTime);
  out = out.replace(/\$context\.httpMethod/g, SAMPLE.httpMethod);
  out = out.replace(/\$context\.resourcePath/g, SAMPLE.resourcePath);
  out = out.replace(/\$context\.status/g, SAMPLE.status);
  out = out.replace(/\$context\.protocol/g, SAMPLE.protocol);
  out = out.replace(/\$context\.responseLength/g, SAMPLE.responseLength);
  return out;
}

async function getLogging(path) {
  const response = await fetch(path);
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

export function StageLoggingTab({ apiId, stageName }) {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", settings: null, error: null });
  const [format, setFormat] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [level, setLevel] = useState("OFF");
  const [dataTrace, setDataTrace] = useState(false);
  const [detailed, setDetailed] = useState(false);
  const [tracing, setTracing] = useState(false);
  const [destinations, setDestinations] = useState("pods");
  const [busy, setBusy] = useState(false);
  const writable = can("pods.stage.write");
  const allowed = can("pods.monitoring.view");

  const path = useMemo(
    () => `/api/v1/projects/${encodeURIComponent(project.id)}/apis/${encodeURIComponent(apiId)}/stages/${encodeURIComponent(stageName)}/logging`,
    [project.id, apiId, stageName],
  );

  const apply = useCallback((data) => {
    const defaults = data.methodSettings?.default ?? {};
    setState({ status: "ready", settings: data, error: null });
    setEnabled(Boolean(data.accessLog?.enabled));
    setFormat(data.accessLog?.format ?? "");
    setLevel(defaults.loggingLevel ?? "OFF");
    setDataTrace(Boolean(defaults.dataTraceEnabled));
    // Show what's stored so a save doesn't silently reset sinks or metrics.
    setDestinations((data.accessLog?.destinations ?? ["pods"]).join(", "));
    setDetailed(Boolean(defaults.metricsEnabled ?? defaults.detailedMetricsEnabled));
    setTracing(Boolean(data.tracingEnabled));
  }, []);

  const refresh = useCallback(async () => {
    setState({ status: "loading", settings: null, error: null });
    try {
      apply(await getLogging(path));
    } catch (error) {
      setState({ status: "error", settings: null, error: error.message });
    }
  }, [apply, path]);

  useEffect(() => {
    if (!allowed) return undefined;
    let alive = true;
    getLogging(path).then(
      (data) => { if (alive) apply(data); },
      (error) => { if (alive) setState({ status: "error", settings: null, error: error.message }); },
    );
    return () => { alive = false; };
  }, [allowed, apply, path]);

  if (!allowed) {
    return <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={LockKeyhole} title="Access unavailable" description="Your current team access does not allow this screen." /></div>;
  }

  const save = async () => {
    setBusy(true);
    try {
      const response = await fetch(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accessLog: { enabled, format, destinations: destinations.split(",").map((entry) => entry.trim()).filter(Boolean) },
          methodSettings: { default: { loggingLevel: level, dataTraceEnabled: dataTrace } },
          detailedMetrics: detailed,
          tracingEnabled: tracing,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
      toast.success("Logging settings saved.");
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  if (state.status === "loading") return <LoadingArea label="Loading logging settings" />;
  if (state.status === "error") {
    return <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={ScrollText}
      title="Settings unavailable"
      description={state.error}
      action={<Button variant="outline" className={SECONDARY} onClick={refresh}>Retry</Button>}
    /></div>;
  }

  return <div className="space-y-6">
    <SectionCard bare title="Access logging" description="One line per request, in your format. The format must include $context.requestId or $context.extendedRequestId.">
      <div className="space-y-5">
        <SettingsList>
          <SettingRow
            icon={FileText}
            title="Access logging"
            description={`Write an access-log line for every request ${stageName} serves.`}
            control={<Switch checked={enabled} onCheckedChange={setEnabled} disabled={!writable} aria-label="Access logging" />}
          />
        </SettingsList>
        <Field label="Format" htmlFor={`stage-log-format-${stageName}`}>
          <Textarea
            id={`stage-log-format-${stageName}`}
            value={format}
            onChange={(event) => setFormat(event.target.value)}
            rows={4}
            className="font-mono text-xs"
            spellCheck={false}
            disabled={!writable}
          />
        </Field>
        {writable ? <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-text-secondary">Start from a preset:</span>
          {PRESETS.map(([name, preset]) => <Button key={name} variant="outline" size="sm" className={SECONDARY} onClick={() => setFormat(preset)}>{name}</Button>)}
        </div> : null}
        <Field label="Preview" hint="Rendered against a sample request.">
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-surface-card p-3 font-mono text-xs text-foreground">{previewFormat(format) || "Enter a format to preview."}</pre>
        </Field>
        <Field
          label="Destinations"
          hint={<>Comma-separated: <span className="font-mono">pods</span> for the built-in log search, and/or sink IDs from <WorkspaceLink section="monitoring/exports" className="underline underline-offset-2 hover:text-foreground">Log Exports</WorkspaceLink>.</>}
          htmlFor={`stage-log-destinations-${stageName}`}
        >
          <Input id={`stage-log-destinations-${stageName}`} value={destinations} onChange={(event) => setDestinations(event.target.value)} className="font-mono" spellCheck={false} disabled={!writable} />
        </Field>
      </div>
    </SectionCard>

    <SectionCard bare title="Execution logging & tracing" description="What the gateway records while it handles each request.">
      <SettingsList>
        <SettingRow
          icon={ScrollText}
          title="Execution logging level"
          description="Errors only, or every step the gateway takes."
          control={<Select value={level} onValueChange={setLevel} disabled={!writable}>
            <SelectTrigger className="w-36" aria-label="Execution logging level"><SelectValue /></SelectTrigger>
            <SelectContent>
              {LOG_LEVELS.some((entry) => entry.value === level) ? null : <SelectItem value={level}>{level}</SelectItem>}
              {LOG_LEVELS.map((entry) => <SelectItem key={entry.value} value={entry.value}>{entry.label}</SelectItem>)}
            </SelectContent>
          </Select>}
        />
        <SettingRow
          icon={Microscope}
          title="Data trace"
          description="Stores request and response bodies (truncated to 1 KB). Only people with pods.logs.data can view them — grant it sparingly."
          control={<Switch checked={dataTrace} onCheckedChange={setDataTrace} disabled={!writable} aria-label="Data trace" />}
        />
        <SettingRow
          icon={Activity}
          title="Detailed metrics"
          description="Per-route metrics for this stage."
          control={<Switch checked={detailed} onCheckedChange={setDetailed} disabled={!writable} aria-label="Detailed metrics" />}
        />
        <SettingRow
          icon={Waypoints}
          title="Tracing"
          description="Samples 1 request per second plus 5% of the rest."
          control={<Switch checked={tracing} onCheckedChange={setTracing} disabled={!writable} aria-label="Tracing" />}
        />
      </SettingsList>
    </SectionCard>

    {writable ? <div className="flex justify-end">
      <Button className={PRIMARY} onClick={save} disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {busy ? "Saving…" : "Save Changes"}
      </Button>
    </div> : null}
  </div>;
}
