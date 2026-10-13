"use client";

import { useEffect, useState } from "react";
import { Cable, ListOrdered, Plus, Trash2 } from "lucide-react";
import { EmptyState, Field, LoadingArea, SectionCard } from "@/components/internal/shared/screen_kit";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { fetchApis } from "./api_list";
import { MethodAuthPicker } from "../auth/auth_picker";
import { MethodRequestEditor, MethodResponseEditor } from "../processing/method_panels";
import { PassthroughPicker, RestMappingEditor } from "../processing/parameter_mapping_editor";
import { TemplateEditor } from "../processing/template_editor";
import { TestTab } from "../releases/test_tab";

const PASSTHROUGH = "__passthrough__";
const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";
const PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";

function Unavailable({ title, description }) {
  return <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={ListOrdered} title={title} description={description} /></div>;
}

function StatusChip({ active, onClick, children }) {
  return <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`inline-flex h-8 items-center gap-2 rounded-lg border px-3 font-mono text-xs transition-colors ${active ? "border-border-strong bg-surface-active font-medium text-foreground" : "border-border bg-surface-card text-text-secondary hover:bg-surface-subtle hover:text-foreground"}`}
  >{children}</button>;
}

function ContentHandlingSelect({ id, value, onChange }) {
  return <Select value={value || PASSTHROUGH} onValueChange={(next) => onChange(next === PASSTHROUGH ? null : next)}>
    <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
    <SelectContent>
      <SelectItem value={PASSTHROUGH}>Pass through unchanged (default)</SelectItem>
      <SelectItem value="CONVERT_TO_TEXT">Convert to text (base64-encode binary)</SelectItem>
      <SelectItem value="CONVERT_TO_BINARY">Convert to binary (base64-decode)</SelectItem>
    </SelectContent>
  </Select>;
}

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

  return <SectionCard
    bare
    title="Method request"
    description="Validator, required parameters and request models for incoming calls."
    action={writable ? <Button size="sm" className={PRIMARY} disabled={busy} onClick={save}>{busy ? "Saving…" : "Save Method Request"}</Button> : null}
  >
    <MethodRequestEditor value={draft} validators={validators} models={models} onChange={setDraft} />
  </SectionCard>;
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

  if (state.status === "loading") return <LoadingArea panel label="Loading method responses" />;
  if (state.status === "error") return <Unavailable title="Method responses unavailable" description={state.error} />;

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

  return <SectionCard
    bare
    title="Method responses"
    description="Status codes this method can return, with their declared headers and models."
    action={writable ? <Button size="sm" className={PRIMARY} disabled={busy} onClick={save}>{busy ? "Saving…" : `Save ${draft.statusCode} Response`}</Button> : null}
  >
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {state.items.map((entry) => <StatusChip key={entry.id} active={String(entry.statusCode) === selected} onClick={() => pick(String(entry.statusCode))}>{entry.statusCode}</StatusChip>)}
        <Input value={selected} onChange={(event) => pick(event.target.value)} placeholder="200" className="h-8 w-20 font-mono text-xs" aria-label="Method response status" />
      </div>
      <MethodResponseEditor value={draft} models={models} onChange={setDraft} />
    </div>
  </SectionCard>;
}

function IntegrationSection({ api, method, onChanged }) {
  const { project } = useProject();
  const { can } = useRbac();
  const apiRef = api.publicId ?? api.id;
  const [state, setState] = useState(method.integrationId
    ? { status: "loading", integration: null, responses: [], error: null }
    : { status: "ready", integration: null, responses: [], error: null });
  const [requestDraft, setRequestDraft] = useState({ requestParameters: {}, requestTemplates: {}, passthroughBehavior: "WHEN_NO_MATCH", contentHandling: "" });
  const [newTemplateType, setNewTemplateType] = useState("application/json");
  const [selectedResponseId, setSelectedResponseId] = useState(null);
  const [responseDraft, setResponseDraft] = useState({ statusCode: "200", selectionPattern: "", responseParameters: {}, responseTemplates: {}, contentHandling: "" });
  const [statusCode, setStatusCode] = useState("200");
  const [pattern, setPattern] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const writable = can("pods.integration.write");

  useEffect(() => {
    let alive = true;
    if (!method.integrationId) return undefined;
    (async () => {
      try {
        const integration = await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/integrations/${encodeURIComponent(method.integrationId)}`);
        const responses = await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/integrations/${encodeURIComponent(method.integrationId)}/responses`);
        if (!alive) return;
        const items = responses.items ?? [];
        setState({ status: "ready", integration, responses: items, error: null });
        setRequestDraft({
          requestParameters: integration.requestParameters ?? {},
          requestTemplates: integration.requestTemplates ?? {},
          passthroughBehavior: integration.passthroughBehavior ?? "WHEN_NO_MATCH",
          contentHandling: integration.contentHandling ?? "",
        });
        const first = items[0];
        if (first) {
          setSelectedResponseId(first.id);
          setResponseDraft({
            statusCode: String(first.statusCode),
            selectionPattern: first.selectionPattern ?? "",
            responseParameters: first.responseParameters ?? {},
            responseTemplates: first.responseTemplates ?? {},
            contentHandling: first.contentHandling ?? "",
          });
        }
      } catch (error) {
        if (alive) setState({ status: "error", integration: null, responses: [], error: error.message });
      }
    })();
    return () => { alive = false; };
  }, [project.id, apiRef, method.integrationId]);

  if (!method.integrationId) {
    return <SectionCard bare title="Integration" description="The backend this method calls.">
      <div className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-surface-card px-6 py-10 text-center text-text-secondary">
        <Cable className="size-6" />
        <p className="text-sm">No integration attached yet — connect one in Integrations to edit its request and response mapping here</p>
      </div>
    </SectionCard>;
  }
  if (state.status === "loading") return <LoadingArea panel label="Loading integration" />;
  if (state.status === "error" || !state.integration) {
    return <Unavailable title="Integration unavailable" description={state.error ?? "Not found."} />;
  }

  const reload = async () => {
    const integration = await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/integrations/${encodeURIComponent(method.integrationId)}`);
    const responses = await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/integrations/${encodeURIComponent(method.integrationId)}/responses`);
    const items = responses.items ?? [];
    setState({ status: "ready", integration, responses: items, error: null });
    setRequestDraft({
      requestParameters: integration.requestParameters ?? {},
      requestTemplates: integration.requestTemplates ?? {},
      passthroughBehavior: integration.passthroughBehavior ?? "WHEN_NO_MATCH",
      contentHandling: integration.contentHandling ?? "",
    });
    return { integration, items };
  };

  const saveRequest = async () => {
    setBusy(true);
    try {
      await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/integrations/${encodeURIComponent(method.integrationId)}`, {
        method: "PATCH",
        headers: { "If-Match": String(state.integration.version) },
        body: JSON.stringify({
          requestParameters: requestDraft.requestParameters ?? {},
          requestTemplates: requestDraft.requestTemplates ?? {},
          passthroughBehavior: requestDraft.passthroughBehavior ?? "WHEN_NO_MATCH",
          ...(requestDraft.contentHandling ? { contentHandling: requestDraft.contentHandling } : {}),
        }),
      });
      toast.success("Saved integration request mapping and templates.");
      await reload();
      onChanged?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const pickResponse = (id) => {
    setSelectedResponseId(id);
    const found = state.responses.find((entry) => entry.id === id);
    if (found) {
      setResponseDraft({
        statusCode: String(found.statusCode),
        selectionPattern: found.selectionPattern ?? "",
        responseParameters: found.responseParameters ?? {},
        responseTemplates: found.responseTemplates ?? {},
        contentHandling: found.contentHandling ?? "",
      });
    }
  };

  const saveResponse = async () => {
    const existing = state.responses.find((entry) => entry.id === selectedResponseId);
    if (!existing) {
      toast.error("Select an integration response first.");
      return;
    }
    setBusy(true);
    try {
      await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/integrations/${encodeURIComponent(method.integrationId)}/responses/${encodeURIComponent(existing.id)}`, {
        method: "PATCH",
        headers: { "If-Match": String(existing.version) },
        body: JSON.stringify({
          selectionPattern: responseDraft.selectionPattern || null,
          responseParameters: responseDraft.responseParameters ?? {},
          responseTemplates: responseDraft.responseTemplates ?? {},
          ...(responseDraft.contentHandling ? { contentHandling: responseDraft.contentHandling } : { contentHandling: null }),
        }),
      });
      toast.success(`Saved ${responseDraft.statusCode} integration response.`);
      await reload();
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
      const { items } = await reload();
      const created = items.find((entry) => String(entry.statusCode) === String(statusCode));
      if (created) pickResponse(created.id);
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
      await reload();
      setSelectedResponseId(null);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const selectedResponse = state.responses.find((entry) => entry.id === selectedResponseId) ?? null;

  return <div className="space-y-8">
    <SectionCard
      bare
      title="Integration request"
      description="How the incoming call is mapped onto the backend request."
      action={writable ? <Button size="sm" className={PRIMARY} disabled={busy} onClick={saveRequest}>{busy ? "Saving…" : "Save Integration Request"}</Button> : null}
    >
      <div className="space-y-4">
        <RestMappingEditor
          title="Request mapping"
          description="Set integration.request.{header|querystring|path}.<name> from method.request.*, a 'static' value, context.* or stageVariables.*."
          rows={requestDraft.requestParameters ?? {}}
          onChange={(requestParameters) => setRequestDraft((current) => ({ ...current, requestParameters }))}
          keyPlaceholder="integration.request.header.X-Target"
          suggestions={["method.request.header.", "method.request.querystring.", "method.request.path.", "method.request.body", "context.", "stageVariables."]}
        />
        <div className="grid gap-4 rounded-xl border border-border bg-surface-card p-4 sm:grid-cols-2">
          <PassthroughPicker value={requestDraft.passthroughBehavior} onChange={(passthroughBehavior) => setRequestDraft((current) => ({ ...current, passthroughBehavior }))} />
          <Field label="Content handling" htmlFor={`ir-content-${method.id}`}>
            <ContentHandlingSelect id={`ir-content-${method.id}`} value={requestDraft.contentHandling} onChange={(contentHandling) => setRequestDraft((current) => ({ ...current, contentHandling }))} />
          </Field>
        </div>
        {Object.entries(requestDraft.requestTemplates ?? {}).map(([contentType, template]) => (
          <TemplateEditor
            key={contentType}
            contentType={contentType}
            value={template}
            onChange={(next) => setRequestDraft((current) => ({ ...current, requestTemplates: { ...current.requestTemplates, [contentType]: next } }))}
            action={writable ? <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${contentType} template`}
              className="text-text-secondary hover:bg-surface-active hover:text-foreground"
              disabled={busy}
              onClick={() => setRequestDraft((current) => {
                const next = { ...(current.requestTemplates ?? {}) };
                delete next[contentType];
                return { ...current, requestTemplates: next };
              })}
            ><Trash2 className="size-4" /></Button> : null}
          />
        ))}
        {writable ? <div className="flex flex-wrap items-end gap-2">
          <Field label="New template content type" htmlFor={`new-template-${method.id}`} className="w-full sm:w-56">
            <Input id={`new-template-${method.id}`} value={newTemplateType} onChange={(event) => setNewTemplateType(event.target.value)} placeholder="application/json" className="font-mono text-xs" />
          </Field>
          <Button
            variant="outline"
            className={SECONDARY}
            disabled={busy || !newTemplateType.trim()}
            onClick={() => setRequestDraft((current) => ({ ...current, requestTemplates: { ...(current.requestTemplates ?? {}), [newTemplateType.trim()]: current.requestTemplates?.[newTemplateType.trim()] ?? "" } }))}
          ><Plus className="size-4" />Add template</Button>
        </div> : null}
      </div>
    </SectionCard>
    <SectionCard
      bare
      title="Integration responses"
      description="Each response matches the backend status (or a function's error message) with a selection pattern; the one with an empty pattern is the default."
    >
      <div className="space-y-4">
        {state.responses.length === 0 ? <p className="text-sm text-text-secondary">No integration responses yet.</p> : <div className="flex flex-wrap items-center gap-2">
          {state.responses.map((response) => <StatusChip key={response.id} active={response.id === selectedResponseId} onClick={() => pickResponse(response.id)}>
            {response.statusCode}
            <span className="font-normal text-text-tertiary">{response.selectionPattern || "default"}</span>
          </StatusChip>)}
        </div>}
        {selectedResponseId ? <div className="space-y-4">
          <div className="grid gap-4 rounded-xl border border-border bg-surface-card p-4 sm:grid-cols-2">
            <Field label="Selection pattern" htmlFor={`ir-edit-pattern-${method.id}`} hint="Regex; leave empty for the default response.">
              <Input id={`ir-edit-pattern-${method.id}`} value={responseDraft.selectionPattern ?? ""} onChange={(event) => setResponseDraft((current) => ({ ...current, selectionPattern: event.target.value }))} placeholder="5\d\d" spellCheck={false} className="font-mono text-xs" />
            </Field>
            <Field label="Content handling" htmlFor={`ir-edit-content-${method.id}`}>
              <ContentHandlingSelect id={`ir-edit-content-${method.id}`} value={responseDraft.contentHandling} onChange={(contentHandling) => setResponseDraft((current) => ({ ...current, contentHandling }))} />
            </Field>
          </div>
          <RestMappingEditor
            title="Response mapping"
            description="Set method.response.header.<name> from integration.response.*. The header must be declared on the 200 method response."
            rows={responseDraft.responseParameters ?? {}}
            onChange={(responseParameters) => setResponseDraft((current) => ({ ...current, responseParameters }))}
            keyPlaceholder="method.response.header.X-Reply"
            suggestions={["integration.response.header.", "integration.response.body", "context.", "stageVariables."]}
          />
          {Object.entries(responseDraft.responseTemplates ?? {}).map(([contentType, template]) => (
            <TemplateEditor
              key={contentType}
              contentType={contentType}
              value={template}
              onChange={(next) => setResponseDraft((current) => ({ ...current, responseTemplates: { ...current.responseTemplates, [contentType]: next } }))}
            />
          ))}
          {writable ? <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" className={PRIMARY} disabled={busy} onClick={saveResponse}>{busy ? "Saving…" : `Save ${responseDraft.statusCode} Response`}</Button>
            <Button
              variant="outline"
              size="sm"
              className={SECONDARY}
              disabled={busy}
              onClick={() => setResponseDraft((current) => ({ ...current, responseTemplates: { ...(current.responseTemplates ?? {}), "application/json": current.responseTemplates?.["application/json"] ?? "" } }))}
            ><Plus className="size-4" />application/json template</Button>
            <Button variant="outline" size="sm" className="ml-auto border-border bg-transparent text-destructive-text hover:bg-surface-active" disabled={busy || !selectedResponse} onClick={() => setConfirmDelete(true)}><Trash2 className="size-4" />Delete response</Button>
          </div> : null}
        </div> : null}
        {writable ? <div className="space-y-4 rounded-xl border border-border bg-surface-card p-4">
          <p className="text-sm font-medium text-foreground">New integration response</p>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Status" htmlFor={`ir-status-${method.id}`}>
              <Input id={`ir-status-${method.id}`} value={statusCode} onChange={(event) => setStatusCode(event.target.value)} className="w-24 font-mono" />
            </Field>
            <Field label="Selection pattern" htmlFor={`ir-pattern-${method.id}`} className="min-w-48 flex-1">
              <Input id={`ir-pattern-${method.id}`} value={pattern} onChange={(event) => setPattern(event.target.value)} placeholder="5\d\d (empty = default)" spellCheck={false} className="font-mono" />
            </Field>
            <Button variant="outline" className={SECONDARY} disabled={busy} onClick={addResponse}><Plus className="size-4" />Add response</Button>
          </div>
        </div> : null}
      </div>
    </SectionCard>
    <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete integration response</DialogTitle>
          <DialogDescription>Delete the <span className="font-mono font-medium text-foreground">{selectedResponse?.statusCode}</span> integration response{selectedResponse?.selectionPattern ? <> matching <span className="font-mono font-medium text-foreground">{selectedResponse.selectionPattern}</span></> : null}? This can&apos;t be undone.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button
            className="bg-red-500/90 text-white hover:bg-red-500"
            disabled={busy}
            onClick={() => {
              setConfirmDelete(false);
              const existing = state.responses.find((entry) => entry.id === selectedResponseId);
              if (existing) removeResponse(existing);
            }}
          ><Trash2 className="size-4" />Delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

/**
 * Full method detail for the resources tab: auth, request/response panels,
 * integration mapping and test invoke. Remounted per method (keyed by the
 * caller) so drafts reset without setState-in-effect.
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
    {lookups.status === "loading" ? <LoadingArea panel label="Loading validators and models" /> : <>
      <MethodRequestSection api={api} resourceId={resourceId} method={method} validators={lookups.validators} models={lookups.models} onSaved={onChanged} />
      <MethodResponsesSection api={api} resourceId={resourceId} method={method} models={lookups.models} />
    </>}
    <IntegrationSection api={api} method={method} onChanged={onChanged} />
    <TestTab api={api} resourceId={resourceId} httpMethod={method.httpMethod} />
  </div>;
}
