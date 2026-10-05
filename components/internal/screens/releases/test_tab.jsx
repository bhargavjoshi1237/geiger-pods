"use client";

import { useState } from "react";
import { FlaskConical } from "lucide-react";
import { EmptyState, SectionCard } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";

async function api(projectId, apiId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/apis/${encodeURIComponent(apiId)}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

/**
 * Test tab on a REST method (S05 §6): a request builder (path, query,
 * headers, body, stage variables) with response and log panes. Test traffic
 * bypasses authorizers/keys/throttles and never touches stages or usage.
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
    return <SectionCard><EmptyState icon={FlaskConical} title="Access unavailable" description="Your current team access does not allow test invocations." /></SectionCard>;
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
      const data = await api(
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

  return <div className="grid gap-4 lg:grid-cols-2">
    <SectionCard title="Request" description="Runs against the draft; stages and usage are untouched.">
      <form className="space-y-4" onSubmit={submit}>
        <div className="space-y-2">
          <Label htmlFor="test-path">Path with query string</Label>
          <Input id="test-path" value={path} onChange={(event) => setPath(event.target.value)} placeholder="/pets?limit=10" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="test-headers">Headers (JSON)</Label>
          <Textarea id="test-headers" value={headersText} onChange={(event) => setHeadersText(event.target.value)} rows={3} spellCheck={false} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="test-body">Body</Label>
          <Textarea id="test-body" value={body} onChange={(event) => setBody(event.target.value)} rows={4} spellCheck={false} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="test-vars">Stage variables (JSON)</Label>
          <Textarea id="test-vars" value={variablesText} onChange={(event) => setVariablesText(event.target.value)} rows={2} spellCheck={false} />
        </div>
        <Button type="submit" disabled={busy}>{busy ? "Invoking…" : "Test invoke"}</Button>
      </form>
    </SectionCard>
    <div className="space-y-4">
      <SectionCard title="Response" description={result ? `Status ${result.status} in ${result.latencyMs} ms` : "No invocation yet."}>
        {result ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{result.body}</pre>
          : <EmptyState icon={FlaskConical} title="No response yet" description="Build a request and invoke the draft method." />}
      </SectionCard>
      <SectionCard title="Execution log" description="AWS-style transcript; secrets are masked.">
        {result ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{result.log}</pre>
          : <p className="text-xs text-muted-foreground">No traffic yet.</p>}
      </SectionCard>
    </div>
  </div>;
}
