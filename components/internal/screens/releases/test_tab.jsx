"use client";

import { useState } from "react";
import { FlaskConical, Loader2, Play, ScrollText } from "lucide-react";
import { EmptyState, Field, SectionCard } from "@/components/internal/shared/screen_kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";

const PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";

async function call(projectId, apiId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/apis/${encodeURIComponent(apiId)}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

function statusVariant(status) {
  const code = Number(status);
  if (code >= 500) return "danger";
  if (code >= 400) return "warning";
  if (code >= 200 && code < 300) return "success";
  return "neutral";
}

/**
 * Test a REST method: a request builder (path, query, headers, body, stage
 * variables) with response and execution-log panes. Test traffic skips
 * authorizers, keys and throttles and never touches stages or usage.
 */
export function TestTab({ api, resourceId, httpMethod }) {
  const { project } = useProject();
  const { can } = useRbac();
  const [path, setPath] = useState("/");
  const [headersText, setHeadersText] = useState("{}");
  const [body, setBody] = useState("");
  const [variablesText, setVariablesText] = useState("{}");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  if (!can("pods.test.invoke")) {
    return <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={FlaskConical} title="Access unavailable" description="Your current team access does not allow test invocations." /></div>;
  }

  const submit = async (event) => {
    event.preventDefault();
    let headers = {};
    let stageVariables = {};
    try {
      headers = JSON.parse(headersText || "{}");
      stageVariables = JSON.parse(variablesText || "{}");
    } catch {
      toast.error("Headers and stage variables must be valid JSON objects.");
      return;
    }
    setBusy(true);
    try {
      const data = await call(
        project.id,
        api.id ?? api.publicId,
        `/resources/${encodeURIComponent(resourceId)}/methods/${encodeURIComponent(httpMethod)}/test-invoke`,
        { method: "POST", body: JSON.stringify({ pathWithQueryString: path, headers, body, stageVariables }) },
      );
      setResult(data);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <div className="space-y-8">
    <SectionCard bare title="Test request" description="Runs against the draft without authorizers, API keys or throttling. Stages and usage are untouched.">
      <form className="space-y-4" onSubmit={submit}>
        <Field label="Path with query string" htmlFor="test-path">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="font-mono">{httpMethod}</Badge>
            <Input id="test-path" className="font-mono" value={path} onChange={(event) => setPath(event.target.value)} placeholder="/pets?limit=10" />
          </div>
        </Field>
        <Field label="Headers (JSON)" htmlFor="test-headers">
          <Textarea id="test-headers" className="font-mono text-xs" value={headersText} onChange={(event) => setHeadersText(event.target.value)} rows={3} spellCheck={false} />
        </Field>
        <Field label="Body" htmlFor="test-body">
          <Textarea id="test-body" className="font-mono text-xs" value={body} onChange={(event) => setBody(event.target.value)} rows={4} spellCheck={false} />
        </Field>
        <Field label="Stage variables (JSON)" htmlFor="test-vars">
          <Textarea id="test-vars" className="font-mono text-xs" value={variablesText} onChange={(event) => setVariablesText(event.target.value)} rows={2} spellCheck={false} />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" size="sm" className={PRIMARY} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="size-4" />}{busy ? "Invoking…" : "Test Invoke"}</Button>
        </div>
      </form>
    </SectionCard>
    <div className="space-y-8">
      <SectionCard
        bare
        title="Response"
        description={result ? `Returned in ${result.latencyMs} ms` : "Send a request to see the response."}
        action={result ? <Badge variant={statusVariant(result.status)} className="font-mono">{result.status}</Badge> : null}
      >
        {result ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-border bg-surface-card p-4 font-mono text-xs text-foreground">{result.body || " "}</pre>
          : <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={FlaskConical} title="No response yet" description="Build a request and invoke the draft method." /></div>}
      </SectionCard>
      <SectionCard bare title="Execution log" description="Step-by-step trace of the invocation. Secrets are masked.">
        {result ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-border bg-surface-card p-4 font-mono text-xs text-text-secondary">{result.log}</pre>
          : <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={ScrollText} title="No traffic yet" description="The trace appears here after a test invoke." /></div>}
      </SectionCard>
    </div>
  </div>;
}
