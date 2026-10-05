"use client";

import { useState } from "react";
import { Database, Plus } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";

/**
 * Models tab: list, JSON schema editor with validation, delete, and
 * "generate from sample JSON". Data operations go through `onCreate`,
 * `onUpdate`, `onDelete` (management API); `models` is the current list.
 */
export function ModelsTab({ models = [], loading = false, error = null, onCreate, onUpdate, onDelete, canWrite = false }) {
  const [creating, setCreating] = useState(false);

  if (loading) return <LogoLoading label="Loading models…" />;
  if (error) return <EmptyState title="Could not load models" description={String(error?.message ?? error)} />;

  return (
    <div className="space-y-4">
      <ScreenHeader title="Models" description="JSON Schema draft-04 documents used for request validation and SDK generation." />
      {models.length === 0 ? (
        <EmptyState icon={Database} title="No models yet" description="Define a model to validate request bodies, then reference it from method requests." />
      ) : (
        models.map((model) => (
          <ModelCard key={model.id ?? model.name} model={model} onUpdate={onUpdate} onDelete={onDelete} canWrite={canWrite} />
        ))
      )}
      {canWrite ? (
        creating ? (
          <ModelForm onCancel={() => setCreating(false)} onSubmit={async (input) => { await onCreate?.(input); setCreating(false); }} />
        ) : (
          <Button type="button" onClick={() => setCreating(true)}><Plus size={16} /> New model</Button>
        )
      ) : null}
    </div>
  );
}

function ModelCard({ model, onUpdate, onDelete, canWrite }) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <SectionCard title={model.name}>
        <p className="text-xs text-muted-foreground">Content type: {model.contentType}</p>
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-xs">{JSON.stringify(model.schema, null, 2)}</pre>
        {canWrite ? (
          <div className="mt-2 flex gap-2">
            <Button type="button" variant="outline" onClick={() => setEditing(true)}>Edit</Button>
            <Button type="button" variant="outline" onClick={() => onDelete?.(model)}>Delete</Button>
          </div>
        ) : null}
      </SectionCard>
    );
  }
  return (
    <SectionCard title={`Edit ${model.name}`}>
      <ModelForm initial={model} submitLabel="Save" onCancel={() => setEditing(false)} onSubmit={async (input) => { await onUpdate?.(model, input); setEditing(false); }} />
    </SectionCard>
  );
}

export function ModelForm({ initial, submitLabel = "Create model", onSubmit, onCancel }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [contentType, setContentType] = useState(initial?.contentType ?? "application/json");
  const [schemaText, setSchemaText] = useState(JSON.stringify(initial?.schema ?? { type: "object" }, null, 2));
  const [sampleText, setSampleText] = useState("");
  const [schemaError, setSchemaError] = useState(null);

  function generateFromSample() {
    try {
      const sample = JSON.parse(sampleText);
      setSchemaText(JSON.stringify(schemaFromSample(sample), null, 2));
      setSchemaError(null);
    } catch (error) {
      setSchemaError(`Sample is not valid JSON: ${error.message}`);
    }
  }

  async function submit() {
    let schema;
    try {
      schema = JSON.parse(schemaText);
    } catch {
      setSchemaError("Schema must be valid JSON.");
      return;
    }
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      setSchemaError("Schema must be a JSON object.");
      return;
    }
    try {
      await onSubmit?.({ name, contentType, schema, description: initial?.description ?? "" });
    } catch (error) {
      toast.error(String(error?.message ?? error));
    }
  }

  return (
    <div className="grid gap-3">
      {!initial ? (
        <div>
          <Label htmlFor="model-name">Name (letters and digits, max 128)</Label>
          <Input id="model-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Order" />
        </div>
      ) : null}
      <div>
        <Label htmlFor="model-content-type">Content type</Label>
        <Input id="model-content-type" value={contentType} onChange={(event) => setContentType(event.target.value)} />
      </div>
      <div>
        <Label htmlFor="model-schema">Schema (JSON Schema draft-04)</Label>
        <Textarea id="model-schema" className="font-mono text-xs" rows={10} value={schemaText} onChange={(event) => setSchemaText(event.target.value)} spellCheck={false} />
      </div>
      <div>
        <Label htmlFor="model-sample">Generate from sample JSON</Label>
        <Textarea id="model-sample" className="font-mono text-xs" rows={4} value={sampleText} onChange={(event) => setSampleText(event.target.value)} placeholder='{"name": "Ada", "age": 36}' spellCheck={false} />
        <Button type="button" variant="outline" onClick={generateFromSample}>Generate schema</Button>
      </div>
      {schemaError ? <p className="text-sm text-red-600">{schemaError}</p> : null}
      <div className="flex gap-2">
        <Button type="button" onClick={submit}>{submitLabel}</Button>
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

/** Infers a draft-04 schema from a sample JSON value. */
export function schemaFromSample(value) {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    return { type: "array", items: value.length > 0 ? schemaFromSample(value[0]) : {} };
  }
  switch (typeof value) {
    case "string": return { type: "string" };
    case "number": return Number.isInteger(value) ? { type: "integer" } : { type: "number" };
    case "boolean": return { type: "boolean" };
    case "object": {
      const properties = {};
      const required = [];
      for (const [key, entry] of Object.entries(value)) {
        properties[key] = schemaFromSample(entry);
        required.push(key);
      }
      return { type: "object", properties, required };
    }
    default: return {};
  }
}
