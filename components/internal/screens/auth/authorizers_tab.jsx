"use client";

// Authorizers tab (S07 §8, API detail): list and create (JWT / Custom
// TOKEN / Custom REQUEST per capability), identity source builder, caching
// TTL, function target picker, a "test authorizer" panel (REST) calling the
// existing `authorizers/[authorizerId]/test` route, and a JWT debugger box
// that decodes a pasted token against the config with no network call.

import { useCallback, useEffect, useState } from "react";
import { Fingerprint, FlaskConical, Plus } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { fetchApis } from "../apis/api_list";
import { authorizerTypesFor, decodeJwtPayload, identitySourceExamples } from "@/lib/workspace/auth-ui.mjs";

function defaultSources(type, protocol) {
  return identitySourceExamples(type, protocol).slice(0, type === "TOKEN" ? 1 : 2);
}

function CreateForm({ protocol, onSubmit, submitting }) {
  const creatable = authorizerTypesFor(protocol);
  const [name, setName] = useState("");
  const [type, setType] = useState(creatable[0] ?? "JWT");
  const [sources, setSources] = useState(defaultSources(creatable[0] ?? "JWT", protocol));
  const [sourceInput, setSourceInput] = useState("");
  const [validation, setValidation] = useState("");
  const [ttl, setTtl] = useState(type === "JWT" ? "0" : "300");
  const [timeoutMs, setTimeoutMs] = useState("10000");
  const [issuer, setIssuer] = useState("");
  const [audiences, setAudiences] = useState("");
  const [provider, setProvider] = useState("webhook");
  const [target, setTarget] = useState("");
  const [payloadVersion, setPayloadVersion] = useState("2.0");
  const [simple, setSimple] = useState(false);

  const pickType = (next) => {
    setType(next);
    setSources(defaultSources(next, protocol));
    setTtl(next === "JWT" ? "0" : protocol === "HTTP" ? "0" : "300");
  };

  const submit = (event) => {
    event.preventDefault();
    if (!name.trim()) {
      toast.error("Name is required.");
      return;
    }
    if (sources.length === 0) {
      toast.error("Add at least one identity source.");
      return;
    }
    const body = {
      name: name.trim(),
      type,
      identitySource: sources,
      ...(type === "TOKEN" && validation.trim() ? { identityValidationExpression: validation.trim() } : {}),
      resultTtlSeconds: Number(ttl || 0),
      timeoutMs: Number(timeoutMs || 10000),
    };
    if (type === "JWT") {
      if (!issuer.trim()) {
        toast.error("Issuer is required for JWT authorizers.");
        return;
      }
      body.jwt = {
        issuer: issuer.trim(),
        ...(audiences.trim() ? { audience: audiences.split(/[\s,]+/).filter(Boolean) } : {}),
      };
    } else {
      if (!target.trim()) {
        toast.error("A function target is required for custom authorizers.");
        return;
      }
      body.function = provider === "webhook" ? { provider, url: target.trim() } : { provider, functionArn: target.trim() };
      if (protocol === "HTTP") {
        body.payloadFormatVersion = payloadVersion;
        body.enableSimpleResponses = simple;
      }
    }
    onSubmit(body);
  };

  return <form className="space-y-4" onSubmit={submit}>
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor="authz-name">Name</Label>
        <Input id="authz-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="mobile-jwt" required />
      </div>
      <div className="space-y-2">
        <Label>Type (per capability for {protocol})</Label>
        <Select value={type} onValueChange={pickType}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>{creatable.map((entry) => <SelectItem key={entry} value={entry}>{entry === "JWT" ? "JWT (Cognito-style / OIDC)" : entry === "TOKEN" ? "Custom TOKEN" : "Custom REQUEST"}</SelectItem>)}</SelectContent>
        </Select>
      </div>
    </div>
    <div className="space-y-2">
      <Label>Identity sources</Label>
      <div className="flex flex-wrap gap-2">
        {sources.map((source) => <button key={source} type="button" className="rounded-full border px-3 py-1 font-mono text-xs" title="Remove" onClick={() => setSources(sources.filter((entry) => entry !== source))}>{source} ✕</button>)}
        {sources.length === 0 ? <p className="text-xs text-muted-foreground">None yet.</p> : null}
      </div>
      <div className="flex gap-2">
        <Input value={sourceInput} onChange={(event) => setSourceInput(event.target.value)} placeholder={identitySourceExamples(type, protocol)[0]} spellCheck={false} aria-label="Add identity source" />
        <Button type="button" variant="outline" onClick={() => {
          const entry = sourceInput.trim();
          if (!entry || sources.includes(entry)) return;
          setSources([...sources, entry]);
          setSourceInput("");
        }}>Add</Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {type === "TOKEN" && protocol === "REST" ? "REST TOKEN takes exactly one header expression. " : ""}
        Examples: {identitySourceExamples(type, protocol).join(", ")}
      </p>
    </div>
    {type === "TOKEN" ? <div className="space-y-2">
      <Label htmlFor="authz-validation">Identity validation regex (optional, TOKEN only)</Label>
      <Input id="authz-validation" value={validation} onChange={(event) => setValidation(event.target.value)} placeholder="^Bearer [A-Za-z0-9-_.]+$" spellCheck={false} />
    </div> : null}
    {type === "JWT" ? <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor="authz-issuer">Issuer (JWKS discovery; Geiger session JWTs use the Supabase auth issuer)</Label>
        <Input id="authz-issuer" value={issuer} onChange={(event) => setIssuer(event.target.value)} placeholder="https://issuer.example.com" spellCheck={false} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="authz-aud">Audiences (comma/space separated, ≤50)</Label>
        <Input id="authz-aud" value={audiences} onChange={(event) => setAudiences(event.target.value)} placeholder="api-audience" spellCheck={false} />
      </div>
    </div> : <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <Label>Function provider</Label>
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="webhook">webhook (any HTTPS function)</SelectItem>
            <SelectItem value="aws_lambda">aws_lambda (ARN + credentials secret)</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="authz-target">{provider === "webhook" ? "Webhook URL" : "Function ARN"}</Label>
        <Input id="authz-target" value={target} onChange={(event) => setTarget(event.target.value)} placeholder={provider === "webhook" ? "https://functions.example.com/authorizer" : "arn:aws:lambda:…:function:authorizer"} spellCheck={false} />
      </div>
    </div>}
    {type !== "JWT" && protocol === "HTTP" ? <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <Label>Payload format version</Label>
        <Select value={payloadVersion} onValueChange={setPayloadVersion}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="1.0">1.0</SelectItem>
            <SelectItem value="2.0">2.0</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={simple} onChange={(event) => setSimple(event.target.checked)} />
        Simple responses (2.0 simple boolean shape)
      </label>
    </div> : null}
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2">
        <Label htmlFor="authz-ttl">Result TTL seconds (0–3600, cache key = identity values)</Label>
        <Input id="authz-ttl" inputMode="numeric" value={ttl} onChange={(event) => setTtl(event.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="authz-timeout">Timeout ms (1000–29000)</Label>
        <Input id="authz-timeout" inputMode="numeric" value={timeoutMs} onChange={(event) => setTimeoutMs(event.target.value)} />
      </div>
    </div>
    <DialogFooter>
      <Button type="submit" disabled={submitting}>{submitting ? "Creating…" : "Create authorizer"}</Button>
    </DialogFooter>
  </form>;
}

function TestPanel({ api, authorizer }) {
  const { project } = useProject();
  const [headersText, setHeadersText] = useState('{"Authorization": "Bearer <token>"}');
  const [queryText, setQueryText] = useState("{}");
  const [variablesText, setVariablesText] = useState("{}");
  const [methodArn, setMethodArn] = useState("");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    let headers = {};
    let queryString = {};
    let stageVariables = {};
    try {
      headers = JSON.parse(headersText || "{}");
      queryString = JSON.parse(queryText || "{}");
      stageVariables = JSON.parse(variablesText || "{}");
    } catch {
      toast.error("Headers, query string and stage variables must be valid JSON objects.");
      return;
    }
    setBusy(true);
    try {
      const data = await fetchApis(project.id, `/${encodeURIComponent(api.publicId ?? api.id)}/authorizers/${encodeURIComponent(authorizer.id)}/test`, {
        method: "POST",
        body: JSON.stringify({ headers, queryString, stageVariables, ...(methodArn.trim() ? { methodArn: methodArn.trim() } : {}) }),
      });
      setResult(data);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <div className="grid gap-4 lg:grid-cols-2">
    <form className="space-y-3" onSubmit={submit}>
      <div className="space-y-2">
        <Label htmlFor={`test-headers-${authorizer.id}`}>Headers (JSON)</Label>
        <Textarea id={`test-headers-${authorizer.id}`} rows={3} value={headersText} onChange={(event) => setHeadersText(event.target.value)} spellCheck={false} className="font-mono text-xs" />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`test-query-${authorizer.id}`}>Query string (JSON)</Label>
        <Textarea id={`test-query-${authorizer.id}`} rows={2} value={queryText} onChange={(event) => setQueryText(event.target.value)} spellCheck={false} className="font-mono text-xs" />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`test-vars-${authorizer.id}`}>Stage variables (JSON)</Label>
        <Textarea id={`test-vars-${authorizer.id}`} rows={2} value={variablesText} onChange={(event) => setVariablesText(event.target.value)} spellCheck={false} className="font-mono text-xs" />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`test-arn-${authorizer.id}`}>Method ARN (optional)</Label>
        <Input id={`test-arn-${authorizer.id}`} value={methodArn} onChange={(event) => setMethodArn(event.target.value)} placeholder="arn:pods:execute-api:…/prod/GET/pets" spellCheck={false} className="font-mono text-xs" />
      </div>
      <Button type="submit" size="sm" disabled={busy}><FlaskConical className="size-4" />{busy ? "Testing…" : "Test authorizer"}</Button>
      <p className="text-xs text-muted-foreground">Bypasses the result cache; secrets are masked in the log.</p>
    </form>
    <div className="space-y-3">
      <SectionCard title="Result" description={result ? `Status ${result.status} · principal ${result.principalId ?? "—"} · ${result.latencyMs ?? "?"} ms` : "No test yet."}>
        {result ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{JSON.stringify({ policy: result.policy, context: result.context }, null, 2)}</pre> : <p className="text-xs text-muted-foreground">No traffic yet.</p>}
      </SectionCard>
      {result?.log ? <SectionCard title="Log">
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{result.log}</pre>
      </SectionCard> : null}
    </div>
  </div>;
}

function JwtDebugger({ authorizer }) {
  const [token, setToken] = useState("");
  const [report, setReport] = useState(null);

  const debug = () => {
    try {
      const { header, payload } = decodeJwtPayload(token);
      const configured = authorizer.jwt ?? {};
      const audiences = [...(configured.audience ?? []), ...(payload.client_id ? [payload.client_id] : [])];
      const checks = [
        { name: "algorithm", ok: !header.alg || header.alg === "none" ? false : true, detail: `alg=${header.alg ?? "missing"} (none and HS* are rejected)` },
        { name: "issuer", ok: !configured.issuer || payload.iss === configured.issuer, detail: `iss=${payload.iss ?? "missing"} vs ${configured.issuer ?? "(unset)"}` },
        { name: "audience", ok: (configured.audience ?? []).length === 0 || (configured.audience ?? []).some((entry) => audiences.includes(entry) || payload.aud === entry || (Array.isArray(payload.aud) && payload.aud.includes(entry))), detail: `aud=${JSON.stringify(payload.aud ?? payload.client_id ?? "missing")} vs ${JSON.stringify(configured.audience ?? [])}` },
        { name: "expiry", ok: typeof payload.exp !== "number" || payload.exp * 1000 > Date.now(), detail: payload.exp ? `exp=${new Date(payload.exp * 1000).toISOString()}` : "exp claim missing (required)" },
      ];
      setReport({ header, payload, checks });
    } catch (error) {
      setReport({ error: error.message });
    }
  };

  if (authorizer.type !== "JWT") return null;
  return <div className="space-y-3 border-t border-border pt-3">
    <p className="text-xs font-medium">JWT debugger (local decode only — no network call)</p>
    <div className="flex gap-2">
      <Input value={token} onChange={(event) => setToken(event.target.value)} placeholder="Paste a JWT (header.payload.signature)" spellCheck={false} className="font-mono text-xs" aria-label="JWT to decode" />
      <Button variant="outline" size="sm" onClick={debug}>Decode</Button>
    </div>
    {report?.error ? <p className="text-xs text-destructive" role="alert">{report.error}</p> : null}
    {report?.payload ? <div className="grid gap-3 lg:grid-cols-2">
      <pre className="overflow-auto rounded bg-muted p-3 font-mono text-xs">{JSON.stringify({ header: report.header, payload: report.payload }, null, 2)}</pre>
      <ul className="space-y-1 text-xs">
        {report.checks.map((check) => <li key={check.name} className="flex gap-2">
          <Badge variant={check.ok ? "outline" : "destructive"}>{check.ok ? "pass" : "fail"}</Badge>
          <span className="font-mono">{check.name}: {check.detail}</span>
        </li>)}
      </ul>
    </div> : null}
  </div>;
}

export function AuthorizersTab({ api }) {
  const { project } = useProject();
  const { can } = useRbac();
  const apiRef = api.publicId ?? api.id;
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState(null);
  const [busy, setBusy] = useState(false);
  const writable = can("pods.authorizer.write");

  const refresh = useCallback(async () => {
    setState({ status: "loading", items: [], error: null });
    try {
      const data = await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/authorizers?limit=100`);
      setState({ status: "ready", items: data.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [project.id, apiRef]);

  useEffect(() => {
    let alive = true;
    fetchApis(project.id, `/${encodeURIComponent(apiRef)}/authorizers?limit=100`).then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id, apiRef]);

  const mutate = async (work, success) => {
    setBusy(true);
    try {
      await work();
      toast.success(success);
      setCreating(false);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <div className="space-y-8">
    <ScreenHeader
      title="Authorizers"
      description="JWT and custom (TOKEN/REQUEST) authorizers. Cached policies are re-evaluated per method ARN — a policy cached from GET /pets may deny POST /pets."
      actions={writable ? <Button onClick={() => setCreating(true)}><Plus className="size-4" />New authorizer</Button> : null}
    />
    {state.status === "loading" ? <SectionCard><div className="flex justify-center py-10"><LogoLoading /></div></SectionCard> : null}
    {state.status === "error" ? <SectionCard><EmptyState icon={Fingerprint} title="Authorizers unavailable" description={state.error} action={<Button variant="outline" onClick={refresh}>Retry</Button>} /></SectionCard> : null}
    {state.status === "ready" && state.items.length === 0 ? <SectionCard><EmptyState icon={Fingerprint} title="No authorizers yet" description={api.protocol === "WEBSOCKET" ? "TOKEN and REQUEST authorizers guard $connect." : "JWT authorizers verify issuer-signed tokens; custom authorizers call your function."} action={writable ? <Button onClick={() => setCreating(true)}>New authorizer</Button> : undefined} /></SectionCard> : null}
    {state.status === "ready" && state.items.length > 0 ? <div className="space-y-4">
      {state.items.map((authorizer) => <SectionCard
        key={authorizer.id}
        title={authorizer.name}
        description={`${authorizer.type} · TTL ${authorizer.resultTtlSeconds ?? 0}s · timeout ${authorizer.timeoutMs ?? 10000} ms`}
      >
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">{authorizer.type}</Badge>
          {(authorizer.identitySource ?? []).map((source) => <code key={source} className="font-mono">{source}</code>)}
          {authorizer.jwt?.issuer ? <span>issuer {authorizer.jwt.issuer}</span> : null}
          {authorizer.function?.provider ? <span>{authorizer.function.provider} {authorizer.function.url ?? authorizer.function.functionArn ?? ""}</span> : null}
          <span className="flex-1" />
          {api.protocol === "REST" && authorizer.type !== "JWT" ? <Button variant="outline" size="sm" onClick={() => setTesting(testing === authorizer.id ? null : authorizer.id)}><FlaskConical className="size-4" />{testing === authorizer.id ? "Hide test" : "Test"}</Button> : null}
          {writable ? <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => mutate(
              () => fetchApis(project.id, `/${encodeURIComponent(apiRef)}/authorizers/${encodeURIComponent(authorizer.id)}`, { method: "DELETE" }),
              `Deleted ${authorizer.name}.`,
            )}
          >Delete</Button> : null}
        </div>
        {testing === authorizer.id ? <div className="pt-4"><TestPanel api={api} authorizer={authorizer} /></div> : null}
        <div className="pt-2"><JwtDebugger authorizer={authorizer} /></div>
      </SectionCard>)}
    </div> : null}
    <Dialog open={creating} onOpenChange={setCreating}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New authorizer</DialogTitle>
          <DialogDescription>JWT verifies signatures via the issuer JWKS; custom authorizers invoke your function with the AWS event shape.</DialogDescription>
        </DialogHeader>
        <CreateForm
          protocol={api.protocol}
          submitting={busy}
          onSubmit={(body) => mutate(
            () => fetchApis(project.id, `/${encodeURIComponent(apiRef)}/authorizers`, { method: "POST", body: JSON.stringify(body) }),
            `Created ${body.name}.`,
          )}
        />
      </DialogContent>
    </Dialog>
  </div>;
}
