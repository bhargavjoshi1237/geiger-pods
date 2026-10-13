"use client";

// Integrations tab on the API detail page: the backends routes point at, with
// URI (live token validation), timeout, connection + connector, TLS options
// and vault-backed backend auth.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Cable, Loader2, Pencil, Plus, PlugZap, Trash2 } from "lucide-react";
import { DataTable, EmptyState, Field as KitField, LoadingArea, SectionCard } from "@/components/internal/shared/screen_kit";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { Slider } from "@geiger/ui/slider";
import { Switch } from "@geiger/ui/switch";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { ListPagination, usePagination } from "@/components/internal/shared/pagination";
import { HttpMappingEditor } from "../processing/parameter_mapping_editor";

const TYPES = ["HTTP_PROXY", "HTTP", "MOCK", "FUNCTION_PROXY", "FUNCTION", "AWS_SERVICE"];

const TYPE_LABEL = {
  HTTP_PROXY: "HTTP proxy",
  HTTP: "HTTP (mapped)",
  MOCK: "Mock",
  FUNCTION_PROXY: "Function proxy",
  FUNCTION: "Function",
  AWS_SERVICE: "AWS service",
};

const AUTH_LABEL = {
  header: "Header",
  bearer: "Bearer token",
  basic_auth: "Basic auth",
  query: "Query parameter",
  oauth_client_credentials: "OAuth client credentials",
  aws_sigv4: "AWS SigV4",
  client_certificate: "Client certificate",
};

const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";
const PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";

function timeoutMax(protocol) {
  return protocol === "HTTP" ? 30000 : 29000;
}

function validateUri(uri) {
  if (!uri) return "URI is required for HTTP integrations.";
  const authority = uri.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "").split("/")[0] ?? "";
  if (/[{}$]/.test(authority)) return "URI must be an http(s) URL template.";
  const probe = uri.replace(/\{[A-Za-z0-9_-]+\+?\}/g, "p").replace(/\$\{[^}]+\}/g, "p");
  try {
    const url = new URL(probe);
    if (!url.host || (url.protocol !== "http:" && url.protocol !== "https:")) return "URI must be an http(s) URL template.";
  } catch {
    return "URI must be an http(s) URL template.";
  }
  const tokens = [...uri.matchAll(/\{([A-Za-z0-9_-]+)\+?\}|\$\{(stageVariables\.[A-Za-z0-9_-]+|request\.path\.[A-Za-z0-9_-]+)\}/g)];
  if (tokens.length === 0 && /\{|\\$\\{/.test(uri)) return "Unrecognized token; use {param}, ${stageVariables.name} or ${request.path.name}.";
  return null;
}

async function api(projectId, apiId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/apis/${encodeURIComponent(apiId)}/integrations${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

function FormSection({ title, description, children }) {
  return <section className="space-y-4 py-5 first:pt-0 last:pb-0">
    <div>
      <h3 className="text-sm font-medium">{title}</h3>
      {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
    </div>
    {children}
  </section>;
}

// The kit Field, with an inline validation message taking the hint's place.
function Field({ id, label, hint, error, className, children }) {
  return <KitField label={label} htmlFor={id} className={className} hint={error ? <span className="text-destructive">{error}</span> : hint}>
    {children}
  </KitField>;
}

function IntegrationForm({ protocol, initial, connectors, onSubmit, onCancel, submitting }) {
  const [type, setType] = useState(initial?.type ?? "HTTP_PROXY");
  const [uri, setUri] = useState(initial?.uri ?? "");
  const [timeoutMs, setTimeoutMs] = useState(initial?.timeoutMs ?? (protocol === "HTTP" ? 30000 : 29000));
  const [connectionType, setConnectionType] = useState(initial?.connectionType ?? "INTERNET");
  const [connectorId, setConnectorId] = useState(initial?.connectorId ?? "");
  const [insecureSkip, setInsecureSkip] = useState(initial?.tls?.insecureSkipVerification ?? false);
  const [serverName, setServerName] = useState(initial?.tls?.serverNameToVerify ?? "");
  const [authType, setAuthType] = useState(initial?.backendAuth?.type ?? "");
  const [secretRef, setSecretRef] = useState(initial?.backendAuth?.secretRef ?? "");
  const [headerName, setHeaderName] = useState(initial?.backendAuth?.headerName ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [mapping, setMapping] = useState({
    request: initial?.requestParameters ?? {},
    responses: initial?.responseParameters ?? {},
  });
  const [templateSelectionExpression, setTemplateSelectionExpression] = useState(initial?.templateSelectionExpression ?? "");
  const [transferMode, setTransferMode] = useState(initial?.responseTransferMode ?? "BUFFERED");
  const [cacheKeysText, setCacheKeysText] = useState((initial?.cacheKeyParameters ?? []).join("\n"));
  const [cacheNamespace, setCacheNamespace] = useState(initial?.cacheNamespace ?? "");
  // Only flag the URI once the user has typed or tried to submit, so a fresh
  // dialog doesn't open with an error.
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const hasUri = type === "HTTP_PROXY" || type === "HTTP";
  const uriError = useMemo(() => (hasUri ? validateUri(uri) : null), [hasUri, uri]);
  const showUriError = uriError && (uri || submitAttempted);
  const max = timeoutMax(protocol);
  return <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => {
    event.preventDefault();
    setSubmitAttempted(true);
    if (uriError) {
      toast.error(uriError);
      return;
    }
    onSubmit({
      type,
      ...(uri ? { uri } : {}),
      timeoutMs: Number(timeoutMs),
      connectionType,
      ...(connectionType === "CONNECTOR" ? { connectorId } : {}),
      tls: { insecureSkipVerification: insecureSkip, serverNameToVerify: serverName || null },
      ...(authType ? { backendAuth: { type: authType, secretRef: secretRef || undefined, headerName: headerName || undefined } } : {}),
      ...(description ? { description } : {}),
      ...(protocol === "HTTP" ? { requestParameters: mapping.request ?? {}, responseParameters: mapping.responses ?? {} } : {}),
      ...(protocol === "WEBSOCKET" && templateSelectionExpression ? { templateSelectionExpression } : {}),
      ...(protocol === "REST" ? {
        responseTransferMode: transferMode,
        cacheKeyParameters: cacheKeysText.split("\n").map((entry) => entry.trim()).filter(Boolean),
        ...(cacheNamespace ? { cacheNamespace } : {}),
      } : {}),
    });
  }}>
    <div className="min-h-0 flex-1 divide-y divide-border overflow-y-auto px-6 py-5">
      <FormSection title="Backend" description="Where matching requests are forwarded.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="integration-type" label="Type">
            <Select value={type} onValueChange={setType}>
              <SelectTrigger id="integration-type" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{TYPES.map((entry) => <SelectItem key={entry} value={entry}>{TYPE_LABEL[entry] ?? entry}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field id="integration-connection" label="Connection">
            <Select value={connectionType} onValueChange={setConnectionType}>
              <SelectTrigger id="integration-connection" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="INTERNET">Internet</SelectItem>
                <SelectItem value="CONNECTOR">Private connector</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        {connectionType === "CONNECTOR" ? <Field id="integration-connector" label="Connector">
          <Select value={connectorId} onValueChange={setConnectorId}>
            <SelectTrigger id="integration-connector" className="w-full"><SelectValue placeholder="Pick a connector" /></SelectTrigger>
            <SelectContent>{connectors.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.name} ({entry.status})</SelectItem>)}</SelectContent>
          </Select>
        </Field> : null}
        {hasUri ? <Field
          id="integration-uri"
          label="URI template"
          error={showUriError ? uriError : null}
          hint={<>Supports <code className="font-mono">{"{param}"}</code>, <code className="font-mono">{"${stageVariables.name}"}</code> and <code className="font-mono">{"${request.path.name}"}</code> tokens.</>}
        >
          <Input
            id="integration-uri"
            className="font-mono text-sm"
            value={uri}
            onChange={(event) => setUri(event.target.value)}
            placeholder="https://backend.example.com/{proxy}"
            aria-invalid={showUriError ? true : undefined}
            spellCheck={false}
          />
        </Field> : null}
        <div className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <Label htmlFor="integration-timeout">Timeout</Label>
            <span className="font-mono text-sm tabular-nums">{Number(timeoutMs).toLocaleString()} ms</span>
          </div>
          <Slider
            id="integration-timeout"
            min={50}
            max={max}
            step={50}
            value={[Number(timeoutMs)]}
            onValueChange={([value]) => setTimeoutMs(value)}
            aria-label="Timeout in milliseconds"
          />
          <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
            <span>50 ms</span>
            <span>{max.toLocaleString()} ms</span>
          </div>
        </div>
      </FormSection>

      <FormSection title="Security" description="TLS to the backend and the credential injected on each call.">
        <div className="flex items-start justify-between gap-4 rounded-lg border border-border px-4 py-3">
          <div className="space-y-0.5">
            <Label htmlFor="integration-tls-insecure">Skip certificate validation</Label>
            <p className="text-xs text-muted-foreground">Accept self-signed or mismatched certificates. Testing only.</p>
          </div>
          <Switch id="integration-tls-insecure" checked={insecureSkip} onCheckedChange={setInsecureSkip} />
        </div>
        <Field id="integration-sni" label="SNI override" hint="Hostname to verify instead of the URI host (optional).">
          <Input id="integration-sni" className="font-mono text-sm" value={serverName} onChange={(event) => setServerName(event.target.value)} placeholder="api.internal.example.com" spellCheck={false} />
        </Field>
        <Field id="integration-backend-auth" label="Backend auth" hint="Secrets resolve at invoke time and never appear in logs or test output.">
          <Select value={authType || "none"} onValueChange={(value) => setAuthType(value === "none" ? "" : value)}>
            <SelectTrigger id="integration-backend-auth" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="header">Header</SelectItem>
              <SelectItem value="bearer">Bearer token</SelectItem>
              <SelectItem value="basic_auth">Basic auth</SelectItem>
              <SelectItem value="query">Query parameter</SelectItem>
              <SelectItem value="oauth_client_credentials">OAuth client credentials</SelectItem>
              <SelectItem value="aws_sigv4">AWS SigV4</SelectItem>
              <SelectItem value="client_certificate">Client certificate</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {authType ? <div className="grid gap-4 sm:grid-cols-2">
          <Field id="integration-secret-ref" label="Vault secret" className={(authType === "header" || authType === "query") ? "" : "sm:col-span-2"}>
            <Input id="integration-secret-ref" className="font-mono text-sm" value={secretRef} onChange={(event) => setSecretRef(event.target.value)} placeholder="secret:<id>" spellCheck={false} />
          </Field>
          {(authType === "header" || authType === "query") ? <Field id="integration-header-name" label={authType === "header" ? "Header name" : "Query param name"}>
            <Input id="integration-header-name" className="font-mono text-sm" value={headerName} onChange={(event) => setHeaderName(event.target.value)} placeholder={authType === "header" ? "X-Api-Key" : "api_key"} spellCheck={false} />
          </Field> : null}
        </div> : null}
      </FormSection>

      {protocol === "HTTP" ? <FormSection title="Parameter mapping">
        <HttpMappingEditor request={mapping.request} responses={mapping.responses} onChange={setMapping} />
      </FormSection> : null}

      {protocol === "WEBSOCKET" ? <FormSection title="WebSocket">
        <Field id="integration-template-selection" label="Template selection expression">
          <Input id="integration-template-selection" value={templateSelectionExpression} onChange={(event) => setTemplateSelectionExpression(event.target.value)} placeholder="$default" spellCheck={false} className="font-mono text-sm" />
        </Field>
      </FormSection> : null}

      {protocol === "REST" ? <FormSection title="Streaming & caching">
        <Field
          id="integration-transfer-mode"
          label="Transfer mode"
          hint={transferMode === "STREAM" ? "Streaming can't be combined with stage caching, response compression or response mapping templates on this method — deploy fails naming the conflict." : null}
        >
          <Select value={transferMode} onValueChange={setTransferMode}>
            <SelectTrigger id="integration-transfer-mode" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="BUFFERED">Buffered</SelectItem>
              <SelectItem value="STREAM">Stream (proxy integrations only)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field id="integration-cache-keys" label="Cache key parameters" hint={<>One per line. Query params outside this list are ignored; for proxy resources <code className="font-mono">{"{proxy}"}</code> is always keyed.</>}>
          <Textarea
            id="integration-cache-keys"
            className="min-h-20 font-mono text-xs"
            value={cacheKeysText}
            onChange={(event) => setCacheKeysText(event.target.value)}
            placeholder={"method.request.querystring.page\nmethod.request.header.Accept"}
            spellCheck={false}
          />
        </Field>
        <Field id="integration-cache-ns" label="Cache namespace (optional)">
          <Input id="integration-cache-ns" value={cacheNamespace} onChange={(event) => setCacheNamespace(event.target.value)} placeholder="v1" spellCheck={false} className="font-mono text-sm" />
        </Field>
      </FormSection> : null}

      <FormSection title="Notes">
        <Field id="integration-description" label="Description (optional)">
          <Textarea id="integration-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={2} placeholder="What this backend is for" />
        </Field>
      </FormSection>
    </div>
    <DialogFooter className="border-t border-border px-6 py-4">
      <Button type="button" variant="outline" className={SECONDARY} onClick={onCancel} disabled={submitting}>Cancel</Button>
      <Button type="submit" className={PRIMARY} disabled={submitting}>{submitting ? <Loader2 className="size-4 animate-spin" /> : null}{initial ? "Save Changes" : "Create Integration"}</Button>
    </DialogFooter>
  </form>;
}

export function IntegrationsTab({ apiId, protocol = "REST" }) {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [connectors, setConnectors] = useState([]);
  const [dialog, setDialog] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const writable = can("pods.integration.write");
  const pager = usePagination(state.items, { resetKey: apiId });

  const refresh = useCallback(async () => {
    setState({ status: "loading", items: [], error: null });
    try {
      const [integrations, connectorList] = await Promise.all([
        api(project.id, apiId, ""),
        fetch(`/api/v1/projects/${encodeURIComponent(project.id)}/connectors`).then((response) => response.json().catch(() => ({ items: [] }))),
      ]);
      setConnectors(connectorList.items ?? []);
      setState({ status: "ready", items: integrations.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [project.id, apiId]);

  useEffect(() => {
    let alive = true;
    api(project.id, apiId, "").then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    fetch(`/api/v1/projects/${encodeURIComponent(project.id)}/connectors`)
      .then((response) => response.json().catch(() => ({ items: [] })))
      .then((data) => { if (alive) setConnectors(data.items ?? []); })
      .catch(() => {});
    return () => { alive = false; };
  }, [project.id, apiId]);

  const mutate = async (work, success) => {
    setBusy(true);
    try {
      await work();
      toast.success(success);
      setDialog(null);
      setDeleteTarget(null);
      await refresh();
    } catch (mutationError) {
      toast.error(mutationError.message);
    } finally {
      setBusy(false);
    }
  };

  if (!writable) {
    return <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={Cable} title="Access unavailable" description="Your current team access does not allow editing integrations." /></div>;
  }

  const columns = [
    { key: "type", header: "Type", render: (row) => <Badge variant="outline">{TYPE_LABEL[row.type] ?? row.type}</Badge> },
    {
      key: "target",
      header: "Target",
      className: "w-full max-w-0",
      render: (row) => <div className="min-w-0">
        <p className="truncate font-mono text-sm text-foreground" title={row.uri ?? undefined}>{row.uri ?? (row.type === "MOCK" ? "Mock response" : "—")}</p>
        {row.description ? <p className="mt-0.5 max-w-[26rem] truncate text-xs text-text-secondary">{row.description}</p> : null}
      </div>,
    },
    { key: "connection", header: "Connection", render: (row) => <span className="text-sm text-text-secondary">{row.connectionType === "CONNECTOR" ? "Private connector" : "Internet"}</span> },
    { key: "auth", header: "Backend auth", render: (row) => <span className="text-sm text-text-secondary">{row.backendAuth ? AUTH_LABEL[row.backendAuth.type] ?? row.backendAuth.type : "None"}</span> },
    { key: "timeout", header: "Timeout", align: "right", render: (row) => <span className="font-mono text-sm tabular-nums text-text-secondary">{Number(row.timeoutMs ?? 0).toLocaleString()} ms</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "w-12 text-right",
      render: (row) => <ActionMenu
        label={`Actions for ${row.uri ?? TYPE_LABEL[row.type] ?? row.type}`}
        disabled={busy}
        items={[
          { icon: Pencil, label: "Edit", onSelect: () => setDialog({ mode: "edit", integration: row }) },
          { separator: true },
          { icon: Trash2, label: "Delete", destructive: true, onSelect: () => setDeleteTarget(row) },
        ]}
      />,
    },
  ];

  const ready = state.status === "ready";

  return <div className="space-y-8">
    <SectionCard
      bare
      title="Backends"
      description={ready && state.items.length > 0 ? `${state.items.length} configured — HTTP proxy, mock, functions, AWS services and private connectors.` : "HTTP proxy, mock, functions, AWS services and private connectors."}
      action={<Button size="sm" className={PRIMARY} onClick={() => setDialog({ mode: "create" })}><Plus className="size-4" />New Integration</Button>}
    >
      {state.status === "loading" ? <LoadingArea panel label="Loading integrations" /> : null}
      {state.status === "error" ? <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={PlugZap} title="Integrations unavailable" description={state.error} action={<Button variant="outline" size="sm" className={SECONDARY} onClick={refresh}>Retry</Button>} /></div> : null}
      {ready && state.items.length === 0 ? <button
        type="button"
        onClick={() => setDialog({ mode: "create" })}
        className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-surface-card py-10 text-text-secondary transition-colors hover:border-border-strong hover:text-muted-foreground"
      >
        <PlugZap className="size-6" />
        <p className="text-sm">No integrations yet — create one to point a route at a backend</p>
      </button> : null}
      {ready && state.items.length > 0 ? <div className="space-y-3">
        <DataTable
          columns={columns}
          data={pager.pageItems}
          getRowKey={(row) => row.id}
          onRowClick={(row) => { if (!busy) setDialog({ mode: "edit", integration: row }); }}
        />
        {state.items.length > 10 ? <ListPagination {...pager} itemLabel="integrations" /> : null}
      </div> : null}
    </SectionCard>

    <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open) setDialog(null); }}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 bg-background p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border px-6 pt-6 pb-4 pr-12">
          <DialogTitle>{dialog?.mode === "edit" ? "Edit Integration" : "New Integration"}</DialogTitle>
          <DialogDescription>Vault secrets are only decrypted on the invoke path — backends never see them anywhere else.</DialogDescription>
        </DialogHeader>
        {dialog ? <IntegrationForm
          protocol={protocol}
          initial={dialog.integration}
          connectors={connectors}
          submitting={busy}
          onCancel={() => setDialog(null)}
          onSubmit={(input) => dialog.mode === "edit"
            ? mutate(
              () => api(project.id, apiId, `/${encodeURIComponent(dialog.integration.id)}`, {
                method: "PATCH",
                headers: { "If-Match": String(dialog.integration.version) },
                body: JSON.stringify(input),
              }),
              "Integration updated.",
            )
            : mutate(
              () => api(project.id, apiId, "", { method: "POST", body: JSON.stringify(input) }),
              "Integration created.",
            )}
        /> : null}
      </DialogContent>
    </Dialog>

    <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !busy) setDeleteTarget(null); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete integration</DialogTitle>
          <DialogDescription>
            Delete the <span className="font-medium text-foreground">{TYPE_LABEL[deleteTarget?.type] ?? deleteTarget?.type}</span> integration
            {deleteTarget?.uri ? <> for <span className="break-all font-mono text-foreground">{deleteTarget.uri}</span></> : null}? Routes using it stop reaching a backend. This can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button
            className="bg-red-500/90 text-white hover:bg-red-500"
            disabled={busy}
            onClick={() => mutate(
              () => api(project.id, apiId, `/${encodeURIComponent(deleteTarget.id)}`, { method: "DELETE" }),
              "Integration deleted.",
            )}
          ><Trash2 className="size-4" />{busy ? "Deleting…" : "Delete"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
