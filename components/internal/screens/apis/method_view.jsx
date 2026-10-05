"use client";

// REST method detail (C1 wiring for the S03 resources tab): the S07 auth
// picker, the S06 method request / method response panels with real
// persistence, the integration passthrough + integration-response controls
// (the persistable S06 surface: mapping tables and VTL templates have no
// management-API writer yet, so those stay out), and the S05 test-invoke tab.

import { useEffect, useState } from "react";
import { ListOrdered } from "lucide-react";
import { EmptyState, SectionCard } from "@geiger/ui/screen-kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { fetchApis } from "./api_list";
import { MethodAuthPicker } from "../auth/auth_picker";
import { MethodRequestEditor, MethodResponseEditor } from "../processing/method_panels";
import { PassthroughPicker } from "../processing/parameter_mapping_editor";
import { TestTab } from "../releases/test_tab";

function MethodRequestSection({ api, resourceId, method, validators, models, onSaved }) {
  const { project } = useProject();
  const { can } = useRbac();
  const apiRef = api.publicId ?? api.id;
  const [draft, setDraft] = useState({
    validatorId: method.requestValidatorId ?? "",
    validateBody: true,
    validateParameters: false,
    requestParameters: method.requestParameters ?? {},
    requestModels: method.requestModels ?? {},
  });
  const [busy, setBusy] = useState(false);
  const writable = can("pods.route.write");

  const save = async () => {
    setBusy(true);
    try {
      const saved = await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/resources/${encodeURIComponent(resourceId)}/methods/${encodeURIComponent(method.httpMethod)}`, {
        method: "PATCH",
        headers: { "If-Match": String(method.version) },
        body: JSON.stringify({
          requestValidatorId: draft.validatorId || null,
          requestParameters: Object.fromEntries(Object.entries(draft.requestParameters ?? {}).map(([key, required]) => [key, required === true || required === "required"])),
          requestModels: draft.requestModels ?? {},
        }),
      });
      toast.success(`Saved method request for ${method.httpMethod}.`);
      onSaved?.(saved);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <div className="space-y-3">
    <MethodRequestEditor value={draft} validators={validators} models={models} onChange={setDraft} />
    {writable ? <Button size="sm" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save method request"}</Button> : null}
  </div>;
}

function MethodResponsesSection({ api, resourceId, method, models }) {
  const { project } = useProject();
  const { can } = useRbac();
  const apiRef = api.publicId ?? api.id;
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [selected, setSelected] = useState("200");
  const [draft, setDraft] = useState({ statusCode: "200", responseParameters: {}, responseModels: {} });
  const [busy, setBusy] = useState(false);
  const writable = can("pods.route.write");
  const base = `/${encodeURIComponent(apiRef)}/resources/${encodeURIComponent(resourceId)}/methods/${encodeURIComponent(method.id)}/method-responses`;

  useEffect(() => {
    let alive = true;
    fetchApis(project.id, base).then(
      (data) => {
        if (!alive) return;
        const items = Array.isArray(data) ? data : (data.items ?? []);
        setState({ status: "ready", items, error: null });
        const first = items[0];
        if (first) {
          setSelected(String(first.statusCode));
          setDraft({ statusCode: String(first.statusCode), responseParameters: first.responseParameters ?? {}, responseModels: first.responseModels ?? {} });
        }
      },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id, base]);

  if (state.status === "loading") return <SectionCard><div className="flex justify-center py-6"><LogoLoading /></div></SectionCard>;
  if (state.status === "error") return <SectionCard><EmptyState icon={ListOrdered} title="Method responses unavailable" description={state.error} /></SectionCard>;

  const pick = (statusCode) => {
    setSelected(statusCode);
    const found = state.items.find((entry) => String(entry.statusCode) === statusCode);
    setDraft(found
      ? { statusCode, responseParameters: found.responseParameters ?? {}, responseModels: found.responseModels ?? {} }
      : { statusCode, responseParameters: {}, responseModels: {} });
  };

  const save = async () => {
    const existing = state.items.find((entry) => String(entry.statusCode) === String(draft.statusCode));
    const parameters = Object.fromEntries(Object.entries(draft.responseParameters ?? {}).map(([key, required]) => [key, required === true || required === "required"]));
    setBusy(true);
    try {
      if (existing) {
        await fetchApis(project.id, `${base}/${encodeURIComponent(String(draft.statusCode))}`, {
          method: "PATCH",
          headers: { "If-Match": String(existing.version) },
          body: JSON.stringify({ responseParameters: parameters, responseModels: draft.responseModels ?? {} }),
        });
      } else {
        await fetchApis(project.id, base, {
          method: "POST",
          body: JSON.stringify({ statusCode: draft.statusCode, responseParameters: parameters, responseModels: draft.responseModels ?? {} }),
        });
      }
      toast.success(`Saved ${draft.statusCode} method response.`);
      const data = await fetchApis(project.id, base);
      const items = Array.isArray(data) ? data : (data.items ?? []);
      setState({ status: "ready", items, error: null });
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      {state.items.map((entry) => <Button key={entry.id} variant={String(entry.statusCode) === selected ? "default" : "outline"} size="sm" onClick={() => pick(String(entry.statusCode))}>{entry.statusCode}</Button>)}
      <div className="flex items-center gap-1">
        <Input value={selected} onChange={(event) => pick(event.target.value)} placeholder="200" className="w-20 font-mono text-xs" aria-label="Method response status" />
      </div>
    </div>
    <MethodResponseEditor value={draft} models={models} onChange={setDraft} />
    {writable ? <Button size="sm" disabled={busy} onClick={save}>{busy ? "Saving…" : `Save ${draft.statusCode} response`}</Button> : null}
  </div>;
}

function IntegrationSection({ api, method, onChanged }) {
  const { project } = useProject();
  const { can } = useRbac();
  const apiRef = api.publicId ?? api.id;
  const [state, setState] = useState(method.integrationId
    ? { status: "loading", integration: null, responses: [], error: null }
    : { status: "ready", integration: null, responses: [], error: null });
  const [passthrough, setPassthrough] = useState("WHEN_NO_MATCH");
  const [statusCode, setStatusCode] = useState("200");
  const [pattern, setPattern] = useState("");
  const [busy, setBusy] = useState(false);
  const writable = can("pods.integration.write");

  useEffect(() => {
    let alive = true;
    if (!method.integrationId) return undefined;
    (async () => {
      try {
        const integration = await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/integrations/${encodeURIComponent(method.integrationId)}`);
        const responses = await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/integrations/${encodeURIComponent(method.integrationId)}/responses`);
        if (!alive) return;
        setState({ status: "ready", integration, responses: responses.items ?? [], error: null });
        setPassthrough(integration.passthroughBehavior ?? "WHEN_NO_MATCH");
      } catch (error) {
        if (alive) setState({ status: "error", integration: null, responses: [], error: error.message });
      }
    })();
    return () => { alive = false; };
  }, [project.id, apiRef, method.integrationId]);

  if (!method.integrationId) {
    return <SectionCard title="Integration" description="Attach an integration on the Integrations tab first; its request/response editors appear here."><p className="text-xs text-muted-foreground">No integration attached to this method yet.</p></SectionCard>;
  }
  if (state.status === "loading") return <SectionCard><div className="flex justify-center py-6"><LogoLoading /></div></SectionCard>;
  if (state.status === "error" || !state.integration) {
    return <SectionCard><EmptyState icon={ListOrdered} title="Integration unavailable" description={state.error ?? "Not found."} /></SectionCard>;
  }

  const savePassthrough = async () => {
    setBusy(true);
    try {
      await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/integrations/${encodeURIComponent(method.integrationId)}`, {
        method: "PATCH",
        headers: { "If-Match": String(state.integration.version) },
        body: JSON.stringify({ passthroughBehavior: passthrough }),
      });
      toast.success("Saved passthrough behavior.");
      onChanged?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const addResponse = async () => {
    setBusy(true);
    try {
      await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/integrations/${encodeURIComponent(method.integrationId)}/responses`, {
        method: "POST",
        body: JSON.stringify({ statusCode, ...(pattern.trim() ? { selectionPattern: pattern.trim() } : {}) }),
      });
      toast.success(`Added ${statusCode} integration response.`);
      const responses = await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/integrations/${encodeURIComponent(method.integrationId)}/responses`);
      setState((current) => ({ ...current, responses: responses.items ?? [] }));
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const removeResponse = async (response) => {
    setBusy(true);
    try {
      await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/integrations/${encodeURIComponent(method.integrationId)}/responses/${encodeURIComponent(response.id)}`, { method: "DELETE" });
      toast.success("Deleted integration response.");
      const responses = await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/integrations/${encodeURIComponent(method.integrationId)}/responses`);
      setState((current) => ({ ...current, responses: responses.items ?? [] }));
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <div className="space-y-8">
    <SectionCard title="Integration request" description="Passthrough behavior for this integration. Parameter mapping tables and VTL templates need the S06 control-plane writer (no management endpoint yet).">
      <PassthroughPicker value={passthrough} onChange={setPassthrough} />
      {writable ? <div className="pt-3"><Button size="sm" disabled={busy} onClick={savePassthrough}>{busy ? "Saving…" : "Save integration request"}</Button></div> : null}
    </SectionCard>
    <SectionCard title="Integration responses" description="Selection patterns match the backend status (or function errorMessage); the default response has an empty pattern.">
      {state.responses.length === 0 ? <p className="text-xs text-muted-foreground">No integration responses yet.</p> : <ul className="space-y-2">
        {state.responses.map((response) => <li key={response.id} className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline">{response.statusCode}</Badge>
          <code className="font-mono text-muted-foreground">{response.selectionPattern || "(default)"}</code>
          {writable ? <Button variant="outline" size="sm" disabled={busy} onClick={() => removeResponse(response)}>Delete</Button> : null}
        </li>)}
      </ul>}
      {writable ? <div className="flex flex-wrap items-end gap-2 pt-3">
        <div className="space-y-2">
          <Label htmlFor={`ir-status-${method.id}`}>Status</Label>
          <Input id={`ir-status-${method.id}`} value={statusCode} onChange={(event) => setStatusCode(event.target.value)} className="w-24 font-mono" />
        </div>
        <div className="min-w-48 flex-1 space-y-2">
          <Label htmlFor={`ir-pattern-${method.id}`}>Selection pattern (regex, empty = default)</Label>
          <Input id={`ir-pattern-${method.id}`} value={pattern} onChange={(event) => setPattern(event.target.value)} placeholder="5\d\d" spellCheck={false} className="font-mono" />
        </div>
        <Button variant="outline" size="sm" disabled={busy} onClick={addResponse}>Add response</Button>
      </div> : null}
    </SectionCard>
  </div>;
}

/**
 * Full method detail for the resources tab: auth, S06 panels, test invoke.
 * Remounted per method (keyed by the caller) so drafts reset without
 * setState-in-effect.
 */
export function MethodDetail({ api, resourceId, method, onChanged }) {
  const { project } = useProject();
  const [lookups, setLookups] = useState({ status: "loading", validators: [], models: [] });

  useEffect(() => {
    let alive = true;
    const apiRef = api.publicId ?? api.id;
    Promise.all([
      fetchApis(project.id, `/${encodeURIComponent(apiRef)}/request-validators`).catch(() => ({ items: [] })),
      fetchApis(project.id, `/${encodeURIComponent(apiRef)}/models?limit=100`).catch(() => ({ items: [] })),
    ]).then(
      ([validators, models]) => {
        if (!alive) return;
        setLookups({ status: "ready", validators: validators.items ?? [], models: models.items ?? [] });
      },
      () => { if (alive) setLookups({ status: "ready", validators: [], models: [] }); },
    );
    return () => { alive = false; };
  }, [project.id, api.publicId, api.id]);

  return <div className="space-y-8">
    <MethodAuthPicker api={api} resourceId={resourceId} method={method} onSaved={onChanged} />
    {lookups.status === "loading" ? <SectionCard><div className="flex justify-center py-6"><LogoLoading /></div></SectionCard> : <>
      <MethodRequestSection api={api} resourceId={resourceId} method={method} validators={lookups.validators} models={lookups.models} onSaved={onChanged} />
      <MethodResponsesSection api={api} resourceId={resourceId} method={method} models={lookups.models} />
    </>}
    <IntegrationSection api={api} method={method} onChanged={onChanged} />
    <TestTab api={api} resourceId={resourceId} httpMethod={method.httpMethod} />
  </div>;
}
