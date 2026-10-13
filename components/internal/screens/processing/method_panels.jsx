"use client";

import { Plus, X } from "lucide-react";
import { Field, SectionCard, SettingRow, SettingsList } from "@/components/internal/shared/screen_kit";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { RestMappingEditor, PassthroughPicker } from "./parameter_mapping_editor";
import { TemplateEditor } from "./template_editor";

/**
 * REST method-panel editors: method request, integration request,
 * integration response and method response. The method request/response
 * editors render their body only; the host supplies the section heading.
 */
const NONE = "__none__";
const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

function Panel({ title, description, children }) {
  return (
    <div className="space-y-4 rounded-xl border border-border bg-surface-card p-4">
      {title ? <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description ? <p className="mt-0.5 text-xs text-text-secondary">{description}</p> : null}
      </div> : null}
      {children}
    </div>
  );
}

export function MethodRequestEditor({ value = {}, validators = [], models = [], onChange }) {
  return (
    <div className="space-y-4">
      <div className="space-y-4 rounded-xl border border-border bg-surface-card p-4">
        <Field label="Request validator" htmlFor="method-validator">
          <Select value={value.validatorId || NONE} onValueChange={(next) => onChange?.({ ...value, validatorId: next === NONE ? null : next })}>
            <SelectTrigger id="method-validator" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>None</SelectItem>
              {validators.map((validator) => <SelectItem key={validator.id ?? validator.name} value={validator.id ?? validator.name}>{validator.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <SettingsList className="border-t border-border pt-4">
          <SettingRow
            title="Validate request body"
            description="Check the body against the request model for its content type."
            checked={value.validateBody ?? true}
            onCheckedChange={(checked) => onChange?.({ ...value, validateBody: checked === true })}
          />
          <SettingRow
            title="Validate request parameters"
            description="Reject requests missing a required header, query string or path parameter."
            checked={value.validateParameters ?? false}
            onCheckedChange={(checked) => onChange?.({ ...value, validateParameters: checked === true })}
          />
        </SettingsList>
      </div>
      <RestMappingEditor
        title="Request parameters"
        description="Declare method.request.{header|querystring|path}.<name> parameters and mark each one required or optional."
        rows={Object.fromEntries(Object.entries(value.requestParameters ?? {}).map(([key, required]) => [key, required ? "required" : "optional"]))}
        onChange={(rows) => onChange?.({
          ...value,
          requestParameters: Object.fromEntries(Object.entries(rows).map(([key, marker]) => [key, marker !== "optional"])),
        })}
        keyPlaceholder="method.request.querystring.page"
        suggestions={["method.request.header.", "method.request.querystring.", "method.request.path."]}
      />
      <Panel title="Request models" description="Content type → model. $default applies when nothing else matches.">
        <ModelTable rows={value.requestModels ?? {}} models={models} onChange={(requestModels) => onChange?.({ ...value, requestModels })} />
      </Panel>
    </div>
  );
}

export function IntegrationRequestEditor({ value = {}, onChange, models = [] }) {
  return (
    <SectionCard bare title="Integration request" description="Parameter mapping, templates and passthrough behavior for the outbound call.">
      <div className="space-y-4">
        <RestMappingEditor
          title="Request mapping"
          rows={value.requestParameters ?? {}}
          onChange={(requestParameters) => onChange?.({ ...value, requestParameters })}
          keyPlaceholder="integration.request.header.X-Target"
          suggestions={["method.request.header.", "method.request.querystring.", "method.request.path.", "method.request.body", "context.", "stageVariables."]}
        />
        <PassthroughPicker value={value.passthroughBehavior} onChange={(passthroughBehavior) => onChange?.({ ...value, passthroughBehavior })} />
        {Object.entries(value.requestTemplates ?? {}).map(([contentType, template]) => (
          <TemplateEditor
            key={contentType}
            contentType={contentType}
            value={template}
            models={models}
            onChange={(next) => onChange?.({ ...value, requestTemplates: { ...value.requestTemplates, [contentType]: next } })}
          />
        ))}
      </div>
    </SectionCard>
  );
}

export function IntegrationResponseEditor({ value = {}, onChange }) {
  return (
    <SectionCard bare title="Integration response" description="Selection pattern, parameter mapping and templates per backend outcome.">
      <div className="space-y-4">
        <div className="grid gap-4 rounded-xl border border-border bg-surface-card p-4 sm:grid-cols-2">
          <Field label="Status code" htmlFor="ir-status">
            <Input id="ir-status" className="font-mono" value={value.statusCode ?? ""} onChange={(event) => onChange?.({ ...value, statusCode: event.target.value })} placeholder="200" />
          </Field>
          <Field label="Selection pattern" htmlFor="ir-pattern" hint="Regex, full match. Leave empty for the default response.">
            <Input id="ir-pattern" className="font-mono" value={value.selectionPattern ?? ""} onChange={(event) => onChange?.({ ...value, selectionPattern: event.target.value })} placeholder="5\d\d" />
          </Field>
        </div>
        <RestMappingEditor
          title="Response mapping"
          rows={value.responseParameters ?? {}}
          onChange={(responseParameters) => onChange?.({ ...value, responseParameters })}
          keyPlaceholder="method.response.header.X-Reply"
          suggestions={["integration.response.header.", "integration.response.body", "context.", "stageVariables."]}
        />
      </div>
    </SectionCard>
  );
}

export function MethodResponseEditor({ value = {}, models = [], onChange }) {
  return (
    <div className="space-y-4">
      <RestMappingEditor
        title={`Response headers${value.statusCode ? ` · ${value.statusCode}` : ""}`}
        description="Declare method.response.header.<name> here before a mapping can target it."
        rows={Object.fromEntries(Object.entries(value.responseParameters ?? {}).map(([key, required]) => [key, required ? "required" : "optional"]))}
        onChange={(rows) => onChange?.({
          ...value,
          responseParameters: Object.fromEntries(Object.entries(rows).map(([key, marker]) => [key, marker !== "optional"])),
        })}
        keyPlaceholder="method.response.header.X-Reply"
        suggestions={["method.response.header."]}
      />
      <Panel title="Response models" description="Content type → model for this status.">
        <ModelTable rows={value.responseModels ?? {}} models={models} onChange={(responseModels) => onChange?.({ ...value, responseModels })} />
      </Panel>
    </div>
  );
}

function ModelTable({ rows = {}, models = [], onChange }) {
  const options = ["Empty", "Error", ...models.map((model) => model.name)];
  return (
    <div className="space-y-3">
      {Object.keys(rows).length === 0 ? <p className="text-xs text-text-secondary">No models yet.</p> : <div className="divide-y divide-border rounded-lg border border-border">
        {Object.entries(rows).map(([contentType, name]) => (
          <div key={contentType} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{contentType}</code>
            <Select value={name} onValueChange={(next) => onChange?.({ ...rows, [contentType]: next })}>
              <SelectTrigger size="sm" className="w-auto min-w-40" aria-label={`Model for ${contentType}`}><SelectValue /></SelectTrigger>
              <SelectContent>
                {options.includes(name) || !name ? null : <SelectItem value={name}>{name}</SelectItem>}
                {options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${contentType}`}
              className="text-text-secondary hover:bg-surface-active hover:text-foreground"
              onClick={() => { const next = { ...rows }; delete next[contentType]; onChange?.(next); }}
            ><X className="size-4" /></Button>
          </div>
        ))}
      </div>}
      <AddModelRow onAdd={(contentType) => onChange?.({ ...rows, [contentType]: "Empty" })} />
    </div>
  );
}

function AddModelRow({ onAdd }) {
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const contentType = String(data.get("contentType") ?? "").trim();
        if (contentType) {
          onAdd?.(contentType);
          event.currentTarget.reset();
        }
      }}
    >
      <Input name="contentType" className="flex-1 font-mono text-xs" placeholder="application/json" aria-label="Content type" />
      <Button type="submit" variant="outline" size="sm" className={`h-9 ${SECONDARY}`}><Plus className="size-4" />Add</Button>
    </form>
  );
}
