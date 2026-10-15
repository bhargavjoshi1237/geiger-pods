"use client";

// Authorizers tab on the API detail page: JWT and custom (TOKEN / REQUEST)
// authorizers with an identity source builder, result caching TTL and function
// target, a test panel for custom REST authorizers, and a JWT debugger that
// decodes a pasted token locally against the authorizer config.

import { useCallback, useEffect, useState } from "react";
import { Fingerprint, FlaskConical, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { DataTable, EmptyState, Field, LoadingArea, SectionCard } from "@/components/internal/shared/screen_kit";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { Switch } from "@geiger/ui/switch";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { fetchApis } from "../apis/api_list";
import { authorizerTypesFor, decodeJwtPayload, identitySourceExamples } from "@/lib/workspace/auth-ui.mjs";

const TYPE_LABEL = { JWT: "JWT", TOKEN: "Custom token", REQUEST: "Custom request" };

const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";
const PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";

function defaultSources(type, protocol) {
  return identitySourceExamples(type, protocol).slice(0, type === "TOKEN" ? 1 : 2);
}

function AuthorizerForm({ protocol, initial, onSubmit, onCancel, submitting }) {
  const creatable = authorizerTypesFor(protocol);
  const editing = Boolean(initial);
  const initialType = initial?.type ?? creatable[0] ?? "JWT";
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState(initialType);
  const [sources, setSources] = useState(initial ? [...(initial.identitySource ?? [])] : defaultSources(initialType, protocol));
  const [sourceInput, setSourceInput] = useState("");
  const [validation, setValidation] = useState(initial?.identityValidationExpression ?? "");
  const [ttl, setTtl] = useState(initial ? String(initial.resultTtlSeconds ?? 0) : initialType === "JWT" ? "0" : "300");
  const [timeoutMs, setTimeoutMs] = useState(initial ? String(initial.timeoutMs ?? 10000) : "10000");
  const [issuer, setIssuer] = useState(initial?.jwt?.issuer ?? "");
  const [audiences, setAudiences] = useState((initial?.jwt?.audience ?? []).join(", "));
  const [provider, setProvider] = useState(initial?.function?.provider ?? "webhook");
  const [target, setTarget] = useState(initial?.function?.url ?? initial?.function?.functionArn ?? "");
  const [payloadVersion, setPayloadVersion] = useState(initial?.payloadFormatVersion ?? "2.0");
  const [simple, setSimple] = useState(Boolean(initial?.enableSimpleResponses));

  const pickType = (next) => {
    setType(next);
    setSources(defaultSources(next, protocol));
    setTtl(next === "JWT" ? "0" : protocol === "HTTP" ? "0" : "300");
  };

  const addSource = () => {
    const entry = sourceInput.trim();
    if (!entry || sources.includes(entry)) return;
    setSources([...sources, entry]);
    setSourceInput("");
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
      ...(editing ? {} : { type }),
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
      const { audience: _audience, ...jwtRest } = initial?.jwt ?? {};
      body.jwt = {
        ...(editing ? jwtRest : {}),
        issuer: issuer.trim(),
        ...(audiences.trim() ? { audience: audiences.split(/[\s,]+/).filter(Boolean) } : {}),
      };
    } else {
      if (!target.trim()) {
        toast.error("A function target is required for custom authorizers.");
        return;
      }
      const { url: _url, functionArn: _arn, ...fnRest } = initial?.function ?? {};
      body.function = {
        ...(editing ? fnRest : {}),
        ...(provider === "webhook" ? { provider, url: target.trim() } : { provider, functionArn: target.trim() }),
      };
      if (protocol === "HTTP") {
        body.payloadFormatVersion = payloadVersion;
        body.enableSimpleResponses = simple;
      }
    }
    onSubmit(body);
  };

  const examples = identitySourceExamples(type, protocol);

  return <form className="space-y-5" onSubmit={submit}>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Name" htmlFor="authz-name">
        <Input id="authz-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="mobile-jwt" required />
      </Field>
      <Field label="Type" htmlFor="authz-type" hint={editing ? "The type can't be changed after creation." : undefined}>
        <Select value={type} onValueChange={pickType} disabled={editing}>
          <SelectTrigger id="authz-type" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{creatable.map((entry) => <SelectItem key={entry} value={entry}>{entry === "JWT" ? "JWT (OIDC issuer)" : entry === "TOKEN" ? "Custom token" : "Custom request"}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
    </div>

    <Field
      label="Identity sources"
      htmlFor="authz-source"
      hint={<>{type === "TOKEN" && protocol === "REST" ? "REST token authorizers take exactly one header. " : ""}For example <span className="font-mono">{examples.join(", ")}</span></>}
    >
      <div className="space-y-2">
        <div className="flex min-h-9 flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-card px-2 py-1.5">
          {sources.map((source) => <Button key={source} type="button" variant="outline" size="xs" className="rounded-full font-mono" title="Remove" onClick={() => setSources(sources.filter((entry) => entry !== source))}>{source}<X /></Button>)}
          {sources.length === 0 ? <span className="px-1 text-xs text-text-secondary">None yet — add one below.</span> : null}
        </div>
        <div className="flex gap-2">
          <Input
            id="authz-source"
            value={sourceInput}
            onChange={(event) => setSourceInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addSource(); } }}
            placeholder={examples[0]}
            spellCheck={false}
            className="font-mono"
            aria-label="Add identity source"
          />
          <Button type="button" variant="outline" className={SECONDARY} onClick={addSource}><Plus className="size-4" />Add</Button>
        </div>
      </div>
    </Field>

    {type === "TOKEN" ? <Field label="Identity validation regex" hint="Optional. Requests whose token doesn't match are rejected before your function runs." htmlFor="authz-validation">
      <Input id="authz-validation" value={validation} onChange={(event) => setValidation(event.target.value)} placeholder="^Bearer [A-Za-z0-9-_.]+$" spellCheck={false} className="font-mono" />
    </Field> : null}

    {type === "JWT" ? <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Issuer" hint="Signing keys are discovered from the issuer's JWKS." htmlFor="authz-issuer">
        <Input id="authz-issuer" value={issuer} onChange={(event) => setIssuer(event.target.value)} placeholder="https://issuer.example.com" spellCheck={false} className="font-mono" />
      </Field>
      <Field label="Audiences" hint="Comma or space separated, up to 50." htmlFor="authz-aud">
        <Input id="authz-aud" value={audiences} onChange={(event) => setAudiences(event.target.value)} placeholder="api-audience" spellCheck={false} className="font-mono" />
      </Field>
    </div> : <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Function" htmlFor="authz-provider">
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger id="authz-provider" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="webhook">Webhook (any HTTPS endpoint)</SelectItem>
            <SelectItem value="aws_lambda">AWS Lambda</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label={provider === "webhook" ? "Webhook URL" : "Function ARN"} htmlFor="authz-target">
        <Input id="authz-target" value={target} onChange={(event) => setTarget(event.target.value)} placeholder={provider === "webhook" ? "https://functions.example.com/authorizer" : "arn:aws:lambda:…:function:authorizer"} spellCheck={false} className="font-mono" />
      </Field>
    </div>}

    {type !== "JWT" && protocol === "HTTP" ? <div className="rounded-xl border border-border bg-surface-card p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Payload format version</p>
          <p className="text-xs text-text-secondary">Shape of the event your function receives.</p>
        </div>
        <Select value={payloadVersion} onValueChange={setPayloadVersion}>
          <SelectTrigger className="w-24" aria-label="Payload format version"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="1.0">1.0</SelectItem>
            <SelectItem value="2.0">2.0</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="mt-4 flex items-center justify-between gap-4 border-t border-border pt-4">
        <div className="min-w-0">
          <label htmlFor="authz-simple" className="text-sm font-medium text-foreground">Simple responses</label>
          <p className="text-xs text-text-secondary">Your function returns {"{ isAuthorized: true | false }"} instead of a policy.</p>
        </div>
        <Switch id="authz-simple" checked={simple} onCheckedChange={(checked) => setSimple(checked === true)} />
      </div>
    </div> : null}

    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Result cache TTL (seconds)" hint="0–3600. Cached per identity value; 0 turns caching off." htmlFor="authz-ttl">
        <Input id="authz-ttl" inputMode="numeric" value={ttl} onChange={(event) => setTtl(event.target.value)} />
      </Field>
      <Field label="Timeout (ms)" hint="1000–29000." htmlFor="authz-timeout">
        <Input id="authz-timeout" inputMode="numeric" value={timeoutMs} onChange={(event) => setTimeoutMs(event.target.value)} />
      </Field>
    </div>

    <DialogFooter>
      <Button type="button" variant="outline" className={SECONDARY} onClick={onCancel}>Cancel</Button>
      <Button type="submit" className={PRIMARY} disabled={submitting}>{submitting ? <Loader2 className="size-4 animate-spin" /> : null}{editing ? "Save Changes" : "Create Authorizer"}</Button>
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

  return <div className="grid gap-6 lg:grid-cols-2">
    <form className="space-y-4" onSubmit={submit}>
      <Field label="Headers (JSON)" htmlFor={`test-headers-${authorizer.id}`}>
        <Textarea id={`test-headers-${authorizer.id}`} rows={3} value={headersText} onChange={(event) => setHeadersText(event.target.value)} spellCheck={false} className="font-mono text-xs" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Query string (JSON)" htmlFor={`test-query-${authorizer.id}`}>
          <Textarea id={`test-query-${authorizer.id}`} rows={2} value={queryText} onChange={(event) => setQueryText(event.target.value)} spellCheck={false} className="font-mono text-xs" />
        </Field>
        <Field label="Stage variables (JSON)" htmlFor={`test-vars-${authorizer.id}`}>
          <Textarea id={`test-vars-${authorizer.id}`} rows={2} value={variablesText} onChange={(event) => setVariablesText(event.target.value)} spellCheck={false} className="font-mono text-xs" />
        </Field>
      </div>
      <Field label="Method ARN" hint="Optional." htmlFor={`test-arn-${authorizer.id}`}>
        <Input id={`test-arn-${authorizer.id}`} value={methodArn} onChange={(event) => setMethodArn(event.target.value)} placeholder="arn:pods:execute-api:…/prod/GET/pets" spellCheck={false} className="font-mono text-xs" />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" className={PRIMARY} disabled={busy}>{busy ? <Loader2 className="size-4 animate-spin" /> : <FlaskConical className="size-4" />}Run Test</Button>
        <p className="text-xs text-text-secondary">Skips the result cache; secrets are masked in the log.</p>
      </div>
    </form>
    <div className="space-y-3">
      <div className="rounded-xl border border-border bg-surface-subtle p-4">
        <p className="text-sm font-medium text-foreground">Result</p>
        <p className="mt-0.5 text-xs text-text-secondary">{result ? `Status ${result.status} · principal ${result.principalId ?? "—"} · ${result.latencyMs ?? "?"} ms` : "Run a test to see the policy and context your function returns."}</p>
        {result ? <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground">{JSON.stringify({ policy: result.policy, context: result.context }, null, 2)}</pre> : null}
      </div>
      {result?.log ? <div className="rounded-xl border border-border bg-surface-subtle p-4">
        <p className="text-sm font-medium text-foreground">Log</p>
        <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-text-secondary">{result.log}</pre>
      </div> : null}
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
  return <div className="space-y-3">
    <p className="text-xs text-text-secondary">Decodes in your browser only — the token is never sent anywhere.</p>
    <div className="flex gap-2">
      <Input value={token} onChange={(event) => setToken(event.target.value)} placeholder="Paste a JWT (header.payload.signature)" spellCheck={false} className="font-mono text-xs" aria-label="JWT to decode" />
      <Button variant="outline" className={SECONDARY} onClick={debug}>Decode</Button>
    </div>
    {report?.error ? <p className="text-xs text-destructive" role="alert">{report.error}</p> : null}
    {report?.payload ? <div className="grid gap-3 lg:grid-cols-2">
      <pre className="max-h-72 overflow-auto rounded-xl border border-border bg-surface-subtle p-3 font-mono text-xs text-foreground">{JSON.stringify({ header: report.header, payload: report.payload }, null, 2)}</pre>
      <ul className="space-y-2 text-xs">
        {report.checks.map((check) => <li key={check.name} className="flex items-start gap-2">
          <Badge variant={check.ok ? "outline" : "destructive"}>{check.ok ? "pass" : "fail"}</Badge>
          <span className="min-w-0 break-all font-mono text-text-secondary"><span className="text-foreground">{check.name}</span>: {check.detail}</span>
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
  const [dialog, setDialog] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [inspect, setInspect] = useState(null);
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
      setDialog(null);
      setDeleteTarget(null);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const emptyText = api.protocol === "WEBSOCKET"
    ? "No authorizers yet — create one to guard $connect"
    : "No authorizers yet — create one to verify tokens or call your own auth function";

  const testable = (authorizer) => api.protocol === "REST" && authorizer.type !== "JWT";

  const columns = [
    {
      key: "name",
      header: "Authorizer",
      render: (authorizer) => {
        const target = authorizer.jwt?.issuer ?? authorizer.function?.url ?? authorizer.function?.functionArn;
        return <div className="min-w-0">
          <p className="font-medium text-foreground">{authorizer.name}</p>
          {target ? <p className="mt-0.5 max-w-xs truncate font-mono text-xs text-text-secondary" title={target}>{target}</p> : null}
        </div>;
      },
    },
    { key: "type", header: "Type", render: (authorizer) => <Badge variant="outline">{TYPE_LABEL[authorizer.type] ?? authorizer.type}</Badge> },
    {
      key: "sources",
      header: "Identity sources",
      render: (authorizer) => (authorizer.identitySource ?? []).length
        ? <span className="font-mono text-xs text-text-secondary">{authorizer.identitySource.join(", ")}</span>
        : <span className="text-xs text-text-tertiary">None</span>,
    },
    { key: "ttl", header: "Cache TTL", align: "right", render: (authorizer) => <span className="text-sm tabular-nums text-text-secondary">{authorizer.resultTtlSeconds ?? 0}s</span> },
    { key: "timeout", header: "Timeout", align: "right", render: (authorizer) => <span className="text-sm tabular-nums text-text-secondary">{Number(authorizer.timeoutMs ?? 10000).toLocaleString()} ms</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (authorizer) => <ActionMenu
        label={`Actions for ${authorizer.name}`}
        disabled={busy}
        items={[
          writable && { icon: Pencil, label: "Edit", onSelect: () => setDialog({ mode: "edit", authorizer }) },
          testable(authorizer) && { icon: FlaskConical, label: "Test", onSelect: () => setInspect(authorizer) },
          authorizer.type === "JWT" && { icon: Fingerprint, label: "Debug token", onSelect: () => setInspect(authorizer) },
          writable && { separator: true },
          writable && { icon: Trash2, label: "Delete", destructive: true, onSelect: () => setDeleteTarget(authorizer) },
        ]}
      />,
    },
  ];

  return <div className="space-y-8">
    <SectionCard
      bare
      title="Configured authorizers"
      description="Cached results are re-checked per method — a policy cached from GET /pets may still deny POST /pets."
      action={writable ? <Button size="sm" className={PRIMARY} onClick={() => setDialog({ mode: "create" })}><Plus className="size-4" />New Authorizer</Button> : null}
    >
      {state.status === "loading" ? <LoadingArea label="Loading authorizers" /> : null}
      {state.status === "error" ? <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={Fingerprint} title="Authorizers unavailable" description={state.error} action={<Button variant="outline" size="sm" className={SECONDARY} onClick={refresh}>Retry</Button>} /></div> : null}
      {state.status === "ready" ? <DataTable
        columns={columns}
        data={state.items}
        getRowKey={(authorizer) => authorizer.id}
        onRowClick={writable ? (authorizer) => { if (!busy) setDialog({ mode: "edit", authorizer }); } : undefined}
        empty={writable ? <button
          type="button"
          onClick={() => setDialog({ mode: "create" })}
          className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-surface-card py-10 text-text-secondary transition-colors hover:border-border-strong hover:text-muted-foreground"
        >
          <Fingerprint className="size-6" />
          <p className="text-sm">{emptyText}</p>
        </button> : <div className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-surface-card py-10 text-text-secondary">
          <Fingerprint className="size-6" />
          <p className="text-sm">No authorizers yet</p>
        </div>}
      /> : null}
    </SectionCard>

    <Dialog open={inspect !== null} onOpenChange={(open) => { if (!open) setInspect(null); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto bg-background sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{inspect?.type === "JWT" ? "Debug Token" : "Test Authorizer"}</DialogTitle>
          <DialogDescription>
            {inspect?.type === "JWT"
              ? <>Decode a token and check it against the issuer and audiences of <span className="font-medium text-foreground">{inspect?.name}</span>.</>
              : <>Call <span className="font-medium text-foreground">{inspect?.name}</span> with a sample request and see the policy it returns.</>}
          </DialogDescription>
        </DialogHeader>
        {inspect ? (inspect.type === "JWT" ? <JwtDebugger key={inspect.id} authorizer={inspect} /> : <TestPanel key={inspect.id} api={api} authorizer={inspect} />) : null}
      </DialogContent>
    </Dialog>

    <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open) setDialog(null); }}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto bg-background">
        <DialogHeader>
          <DialogTitle>{dialog?.mode === "edit" ? "Edit Authorizer" : "New Authorizer"}</DialogTitle>
          <DialogDescription>JWT authorizers verify signatures with the issuer&apos;s keys; custom authorizers call your function with the request&apos;s identity.</DialogDescription>
        </DialogHeader>
        {dialog ? <AuthorizerForm
          key={dialog.authorizer?.id ?? "new"}
          protocol={api.protocol}
          initial={dialog.authorizer}
          submitting={busy}
          onCancel={() => setDialog(null)}
          onSubmit={(body) => dialog.mode === "edit"
            ? mutate(
              () => fetchApis(project.id, `/${encodeURIComponent(apiRef)}/authorizers/${encodeURIComponent(dialog.authorizer.id)}`, {
                method: "PATCH",
                headers: { "If-Match": String(dialog.authorizer.version) },
                body: JSON.stringify(body),
              }),
              `Updated ${body.name}.`,
            )
            : mutate(
              () => fetchApis(project.id, `/${encodeURIComponent(apiRef)}/authorizers`, { method: "POST", body: JSON.stringify(body) }),
              `Created ${body.name}.`,
            )}
        /> : null}
      </DialogContent>
    </Dialog>

    <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !busy) setDeleteTarget(null); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete authorizer</DialogTitle>
          <DialogDescription>
            Delete <span className="font-medium text-foreground">{deleteTarget?.name}</span>? Methods and routes that use it lose their authorization check. This can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button
            className="bg-red-500/90 text-white hover:bg-red-500"
            disabled={busy}
            onClick={() => mutate(
              () => fetchApis(project.id, `/${encodeURIComponent(apiRef)}/authorizers/${encodeURIComponent(deleteTarget.id)}`, { method: "DELETE" }),
              `Deleted ${deleteTarget.name}.`,
            )}
          ><Trash2 className="size-4" />{busy ? "Deleting…" : "Delete"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
