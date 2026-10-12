"use client";

import { ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Label } from "@geiger/ui/label";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Checkbox } from "@geiger/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { RestMappingEditor, PassthroughPicker } from "./parameter_mapping_editor";
import { TemplateEditor } from "./template_editor";

/**
 * REST method-panel editors (standalone; mounted on the S03 method panel by
 * the orchestrator later): method request, integration request, integration
 * response and method response.
 */
const NONE = "__none__";

export function MethodRequestEditor({ value = {}, validators = [], models = [], onChange }) {
  return (
    <div className="space-y-4">
      <ScreenHeader title="Method request" description="Required parameters, request validator and per-content-type request models." />
      <SectionCard title="Validator">
        <Label htmlFor="method-validator">Request validator</Label>
        <Select value={value.validatorId || NONE} onValueChange={(next) => onChange?.({ ...value, validatorId: next === NONE ? null : next })}>
          <SelectTrigger id="method-validator" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>None</SelectItem>
            {validators.map((validator) => <SelectItem key={validator.id ?? validator.name} value={validator.id ?? validator.name}>{validator.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="mt-2 flex items-center gap-2">
          <Checkbox id="method-validate-body" checked={value.validateBody ?? true} onCheckedChange={(checked) => onChange?.({ ...value, validateBody: checked === true })} />
          <Label htmlFor="method-validate-body" className="font-normal">Validate request body</Label>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Checkbox id="method-validate-params" checked={value.validateParameters ?? false} onCheckedChange={(checked) => onChange?.({ ...value, validateParameters: checked === true })} />
          <Label htmlFor="method-validate-params" className="font-normal">Validate request parameters</Label>
        </div>
      </SectionCard>
      <RestMappingEditor
        title="Request parameters"
        description="method.request.{header|querystring|path}.<name> — check required to enforce presence."
        rows={Object.fromEntries(Object.entries(value.requestParameters ?? {}).map(([key, required]) => [key, required ? "required" : "optional"]))}
        onChange={(rows) => onChange?.({
          ...value,
          requestParameters: Object.fromEntries(Object.entries(rows).map(([key, marker]) => [key, marker !== "optional"])),
        })}
        keyPlaceholder="method.request.querystring.page"
        suggestions={["method.request.header.", "method.request.querystring.", "method.request.path."]}
      />
      <SectionCard title="Request models">
        <p className="mb-2 text-sm text-muted-foreground">Content type → model. $default applies when nothing else matches.</p>
        <ModelTable rows={value.requestModels ?? {}} models={models} onChange={(requestModels) => onChange?.({ ...value, requestModels })} />
      </SectionCard>
    </div>
  );
}

export function IntegrationRequestEditor({ value = {}, onChange, models = [] }) {
  return (
    <div className="space-y-4">
      <ScreenHeader title="Integration request" description="Parameter mapping, templates and passthrough behavior for the outbound call." />
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
  );
}

export function IntegrationResponseEditor({ value = {}, onChange }) {
  return (
    <div className="space-y-4">
      <ScreenHeader title="Integration response" description="Selection pattern, parameter mapping and templates per backend outcome." />
      <SectionCard title="Selection">
        <Label htmlFor="ir-status">Status code</Label>
        <Input id="ir-status" className="font-mono" value={value.statusCode ?? ""} onChange={(event) => onChange?.({ ...value, statusCode: event.target.value })} placeholder="200" />
        <Label htmlFor="ir-pattern">Selection pattern (regex, full match; empty = default)</Label>
        <Input id="ir-pattern" className="font-mono" value={value.selectionPattern ?? ""} onChange={(event) => onChange?.({ ...value, selectionPattern: event.target.value })} placeholder="5\d\d" />
      </SectionCard>
      <RestMappingEditor
        title="Response mapping"
        rows={value.responseParameters ?? {}}
        onChange={(responseParameters) => onChange?.({ ...value, responseParameters })}
        keyPlaceholder="method.response.header.X-Reply"
        suggestions={["integration.response.header.", "integration.response.body", "context.", "stageVariables."]}
      />
    </div>
  );
}

export function MethodResponseEditor({ value = {}, models = [], onChange }) {
  return (
    <div className="space-y-4">
      <ScreenHeader title="Method response" description="Declared status, required headers and per-content-type response models." />
      <SectionCard title={`Status ${value.statusCode ?? ""}`}>
        <RestMappingEditor
          title="Response parameters"
          description="Headers must be declared here before a mapping can target them."
          rows={Object.fromEntries(Object.entries(value.responseParameters ?? {}).map(([key, required]) => [key, required ? "required" : "optional"]))}
          onChange={(rows) => onChange?.({
            ...value,
            responseParameters: Object.fromEntries(Object.entries(rows).map(([key, marker]) => [key, marker !== "optional"])),
          })}
          keyPlaceholder="method.response.header.X-Reply"
          suggestions={["method.response.header."]}
        />
        <div className="mt-3">
          <p className="mb-2 text-sm font-medium">Response models</p>
          <ModelTable rows={value.responseModels ?? {}} models={models} onChange={(responseModels) => onChange?.({ ...value, responseModels })} />
        </div>
      </SectionCard>
    </div>
  );
}

function ModelTable({ rows = {}, models = [], onChange }) {
  const options = ["Empty", "Error", ...models.map((model) => model.name)];
  return (
    <div className="space-y-2">
      {Object.entries(rows).map(([contentType, name]) => (
        <div key={contentType} className="flex flex-wrap items-center gap-2">
          <code className="text-xs">{contentType}</code>
          <Select value={name} onValueChange={(next) => onChange?.({ ...rows, [contentType]: next })}>
            <SelectTrigger size="sm" className="w-auto min-w-40 flex-1" aria-label={`Model for ${contentType}`}><SelectValue /></SelectTrigger>
            <SelectContent>
              {options.includes(name) || !name ? null : <SelectItem value={name}>{name}</SelectItem>}
              {options.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button type="button" variant="outline" size="sm" onClick={() => { const next = { ...rows }; delete next[contentType]; onChange?.(next); }}>Remove</Button>
        </div>
      ))}
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
      <Input name="contentType" className="flex-1" placeholder="application/json" aria-label="Content type" />
      <Button type="submit" variant="outline">Add</Button>
    </form>
  );
}
