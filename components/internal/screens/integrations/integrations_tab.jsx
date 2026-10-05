"use client";

// Integrations tab (S04 §7). Standalone exported component: the orchestrator
// wires it into the API detail tabs later, so this file registers nothing.
// Lists integrations per type and edits URI (with live token validation),
// timeout, connection type + connector picker, TLS options and backend auth.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Cable, Plus, PlugZap } from "lucide-react";
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
import { HttpMappingEditor } from "../processing/parameter_mapping_editor";

const TYPES = ["HTTP_PROXY", "HTTP", "MOCK", "FUNCTION_PROXY", "FUNCTION", "AWS_SERVICE"];

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

function IntegrationForm({ protocol, initial, connectors, onSubmit, submitting }) {
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
  const uriError = useMemo(() => ((type === "HTTP_PROXY" || type === "HTTP") ? validateUri(uri) : null), [type, uri]);
  const max = timeoutMax(protocol);
  return <form className="space-y-4" onSubmit={(event) => {
    event.preventDefault();
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
    });
  }}>
    <div className="space-y-2">
      <Label>Type</Label>
      <Select value={type} onValueChange={setType}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>{TYPES.map((entry) => <SelectItem key={entry} value={entry}>{entry}</SelectItem>)}</SelectContent>
      </Select>
    </div>
    {(type === "HTTP_PROXY" || type === "HTTP") ? <div className="space-y-2">
      <Label htmlFor="integration-uri">URI template</Label>
      <Input id="integration-uri" value={uri} onChange={(event) => setUri(event.target.value)} placeholder="https://backend.example.com/{proxy}?v=${stageVariables.ver}" spellCheck={false} />
      {uriError ? <p className="text-xs text-destructive">{uriError}</p>
        : <p className="text-xs text-muted-foreground">Supports {"{param}"}, {"${stageVariables.name}"} and {"${request.path.name}"} tokens.</p>}
    </div> : null}
    <div className="space-y-2">
      <Label htmlFor="integration-timeout">Timeout (50 ms – {max} ms): {timeoutMs} ms</Label>
      <Input id="integration-timeout" type="range" min={50} max={max} step={50} value={timeoutMs} onChange={(event) => setTimeoutMs(event.target.value)} />
    </div>
    <div className="space-y-2">
      <Label>Connection</Label>
      <Select value={connectionType} onValueChange={setConnectionType}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="INTERNET">INTERNET</SelectItem>
          <SelectItem value="CONNECTOR">CONNECTOR (private)</SelectItem>
        </SelectContent>
      </Select>
    </div>
    {connectionType === "CONNECTOR" ? <div className="space-y-2">
      <Label>Connector</Label>
      <Select value={connectorId} onValueChange={setConnectorId}>
        <SelectTrigger><SelectValue placeholder="Pick a connector" /></SelectTrigger>
        <SelectContent>{connectors.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.name} ({entry.status})</SelectItem>)}</SelectContent>
      </Select>
    </div> : null}
    <div className="space-y-2">
      <Label>Backend TLS</Label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={insecureSkip} onChange={(event) => setInsecureSkip(event.target.checked)} />
        Skip certificate chain validation (testing only)
      </label>
      <Input value={serverName} onChange={(event) => setServerName(event.target.value)} placeholder="SNI override (serverNameToVerify)" spellCheck={false} />
    </div>
    <div className="space-y-2">
      <Label>Backend auth (vault-injected credential)</Label>
      <Select value={authType} onValueChange={setAuthType}>
        <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="header">header</SelectItem>
          <SelectItem value="bearer">bearer</SelectItem>
          <SelectItem value="basic_auth">basic_auth</SelectItem>
          <SelectItem value="query">query</SelectItem>
          <SelectItem value="oauth_client_credentials">oauth_client_credentials</SelectItem>
          <SelectItem value="aws_sigv4">aws_sigv4</SelectItem>
          <SelectItem value="client_certificate">client_certificate</SelectItem>
        </SelectContent>
      </Select>
      {authType ? <Input value={secretRef} onChange={(event) => setSecretRef(event.target.value)} placeholder="secret:<id>" spellCheck={false} /> : null}
      {(authType === "header" || authType === "query") ? <Input value={headerName} onChange={(event) => setHeaderName(event.target.value)} placeholder="Header / query param name" spellCheck={false} /> : null}
      <p className="text-xs text-muted-foreground">Secrets resolve at invoke time and never appear in logs or test output.</p>
    </div>
    <div className="space-y-2">
      <Label htmlFor="integration-description">Description (optional)</Label>
      <Textarea id="integration-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={2} />
    </div>
    {protocol === "HTTP" ? <HttpMappingEditor request={mapping.request} responses={mapping.responses} onChange={setMapping} /> : null}
    {protocol === "WEBSOCKET" ? <div className="space-y-2">
      <Label htmlFor="integration-template-selection">Template selection expression (WebSocket)</Label>
      <Input id="integration-template-selection" value={templateSelectionExpression} onChange={(event) => setTemplateSelectionExpression(event.target.value)} placeholder="$default" spellCheck={false} className="font-mono" />
    </div> : null}
    <DialogFooter>
      <Button type="submit" disabled={submitting}>{submitting ? "Saving…" : initial ? "Save changes" : "Create integration"}</Button>
    </DialogFooter>
  </form>;
}

export function IntegrationsTab({ apiId, protocol = "REST" }) {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [connectors, setConnectors] = useState([]);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const writable = can("pods.integration.write");

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
      await refresh();
    } catch (mutationError) {
      toast.error(mutationError.message);
    } finally {
      setBusy(false);
    }
  };

  if (!writable) {
    return <SectionCard><EmptyState icon={Cable} title="Access unavailable" description="Your current team access does not allow editing integrations." /></SectionCard>;
  }

  return <div className="space-y-8">
    <ScreenHeader
      title="Integrations"
      description="Backends for your routes: HTTP proxy, mock, functions, AWS services and private connectors."
      actions={<Button onClick={() => setDialog({ mode: "create" })}><Plus className="size-4" />New integration</Button>}
    />
    {state.status === "loading" ? <SectionCard><div className="flex justify-center py-10"><LogoLoading /></div></SectionCard> : null}
    {state.status === "error" ? <SectionCard><EmptyState icon={PlugZap} title="Integrations unavailable" description={state.error} action={<Button variant="outline" onClick={refresh}>Retry</Button>} /></SectionCard> : null}
    {state.status === "ready" && state.items.length === 0 ? <SectionCard><EmptyState icon={PlugZap} title="No integrations yet" description="Point your first route at a backend. HTTP proxy is the fastest start." action={<Button onClick={() => setDialog({ mode: "create" })}>New integration</Button>} /></SectionCard> : null}
    {state.status === "ready" && state.items.length > 0 ? <SectionCard title="Integrations" description={`${state.items.length} configured.`}>
      <ul className="divide-y divide-border">
        {state.items.map((integration) => <li key={integration.id} className="flex flex-wrap items-center gap-3 py-4 first:pt-0 last:pb-0">
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-sm">{integration.uri ?? integration.type}</p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">{integration.type}</Badge>
              <Badge variant="outline">{integration.connectionType}</Badge>
              <span>{integration.timeoutMs} ms</span>
              {integration.backendAuth ? <span>auth: {integration.backendAuth.type}</span> : null}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setDialog({ mode: "edit", integration })}>Edit</Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => mutate(
                () => api(project.id, apiId, `/${encodeURIComponent(integration.id)}`, { method: "DELETE" }),
                "Integration deleted.",
              )}
            >Delete</Button>
          </div>
        </li>)}
      </ul>
    </SectionCard> : null}
    <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open) setDialog(null); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{dialog?.mode === "edit" ? "Edit integration" : "New integration"}</DialogTitle>
          <DialogDescription>Backends never see your vault secrets in plain text outside the invoke path.</DialogDescription>
        </DialogHeader>
        {dialog ? <IntegrationForm
          protocol={protocol}
          initial={dialog.integration}
          connectors={connectors}
          submitting={busy}
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
  </div>;
}
