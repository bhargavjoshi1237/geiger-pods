"use client";

// Stage → Logs & tracing sub-tab (S10 §9): access-log toggle and format
// presets/editor with live preview against a sample context, destinations,
// execution-log level, data trace (with a warning), detailed metrics and the
// tracing toggle.

import { useCallback, useEffect, useMemo, useState } from "react";
import { LockKeyhole } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";

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

  const path = useMemo(
    () => `/api/v1/projects/${encodeURIComponent(project.id)}/apis/${encodeURIComponent(apiId)}/stages/${encodeURIComponent(stageName)}/logging`,
    [project.id, apiId, stageName],
  );

  const refresh = useCallback(async () => {
    setState({ status: "loading", settings: null, error: null });
    try {
      const response = await fetch(path);
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
      setState({ status: "ready", settings: data, error: null });
      setEnabled(Boolean(data.accessLog?.enabled));
      setFormat(data.accessLog?.format ?? "");
      setLevel(data.methodSettings?.default?.loggingLevel ?? "OFF");
      setDataTrace(Boolean(data.methodSettings?.default?.dataTraceEnabled));
      setTracing(Boolean(data.tracingEnabled));
    } catch (error) {
      setState({ status: "error", settings: null, error: error.message });
    }
  }, [path]);

  useEffect(() => {
    let alive = true;
    fetch(path).then(
      async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
        if (!alive) return;
        setState({ status: "ready", settings: data, error: null });
        setEnabled(Boolean(data.accessLog?.enabled));
        setFormat(data.accessLog?.format ?? "");
        setLevel(data.methodSettings?.default?.loggingLevel ?? "OFF");
        setDataTrace(Boolean(data.methodSettings?.default?.dataTraceEnabled));
        setTracing(Boolean(data.tracingEnabled));
      },
      (error) => { if (alive) setState({ status: "error", settings: null, error: error.message }); },
    );
    return () => { alive = false; };
  }, [path]);

  if (!can("pods.monitoring.view")) {
    return <SectionCard><EmptyState icon={LockKeyhole} title="Access unavailable" description="Your current team access does not allow this screen." /></SectionCard>;
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

  return <div className="space-y-8">
    <ScreenHeader title={`Logs & tracing — ${stageName}`} description="Access logs, execution logs, detailed metrics and tracing for this stage." />
    {state.status === "loading" ? <SectionCard><div className="flex justify-center py-10"><LogoLoading /></div></SectionCard> : null}
    {state.status === "error" ? <SectionCard><EmptyState icon={LockKeyhole} title="Settings unavailable" description={state.error} action={<Button variant="outline" onClick={refresh}>Retry</Button>} /></SectionCard> : null}
    {state.status === "ready" ? <>
      <SectionCard title="Access log" description="The format must contain $context.requestId or $context.extendedRequestId.">
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={!writable} />
            Access logging enabled
          </label>
          <div className="flex flex-wrap gap-2">
            {[["CLF", "$context.identity.sourceIp $context.identity.caller $context.identity.user [$context.requestTime] \"$context.httpMethod $context.resourcePath $context.protocol\" $context.status $context.responseLength $context.requestId"], ["JSON", "{ \"requestId\":\"$context.requestId\", \"ip\": \"$context.identity.sourceIp\", \"caller\":\"$context.identity.caller\", \"user\":\"$context.identity.user\",\"requestTime\":\"$context.requestTime\", \"httpMethod\":\"$context.httpMethod\",\"resourcePath\":\"$context.resourcePath\", \"status\":\"$context.status\",\"protocol\":\"$context.protocol\", \"responseLength\":\"$context.responseLength\" }"]].map(([name, preset]) => <Button key={name} variant="outline" size="sm" disabled={!writable} onClick={() => setFormat(preset)}>{name} preset</Button>)}
          </div>
          <div className="space-y-2">
            <Label htmlFor="stage-log-format">Format</Label>
            <Textarea id="stage-log-format" value={format} onChange={(event) => setFormat(event.target.value)} rows={4} spellCheck={false} disabled={!writable} />
          </div>
          <div>
            <p className="text-sm font-medium">Live preview (sample context)</p>
            <pre className="mt-1 overflow-x-auto rounded bg-muted p-3 font-mono text-xs">{previewFormat(format) || "Enter a format to preview."}</pre>
          </div>
          <div className="space-y-2">
            <Label htmlFor="stage-log-destinations">Destinations (comma-separated: pods and/or sink ids)</Label>
            <Input id="stage-log-destinations" value={destinations} onChange={(event) => setDestinations(event.target.value)} disabled={!writable} />
          </div>
        </div>
      </SectionCard>
      <SectionCard title="Execution log & tracing" description="Data trace includes request/response bodies (truncated to 1 KB) and needs pods.logs.data to view.">
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="stage-log-level">Logging level (OFF / ERROR / INFO)</Label>
            <Input id="stage-log-level" value={level} onChange={(event) => setLevel(event.target.value.toUpperCase())} disabled={!writable} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={dataTrace} onChange={(event) => setDataTrace(event.target.checked)} disabled={!writable} />
            Data trace (warning: bodies are stored — restrict pods.logs.data)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={detailed} onChange={(event) => setDetailed(event.target.checked)} disabled={!writable} />
            Detailed (per-route) metrics
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={tracing} onChange={(event) => setTracing(event.target.checked)} disabled={!writable} />
            Tracing (1 req/s reservoir + 5% sampling)
          </label>
          {writable ? <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save settings"}</Button> : null}
        </div>
      </SectionCard>
    </> : null}
  </div>;
}
