"use client";

import { useState } from "react";
import { Database, Eye, Loader2, Pencil, Plus, Trash2, Wand2 } from "lucide-react";
import { DataTable, EmptyState, Field, LoadingArea, SectionCard } from "@/components/internal/shared/screen_kit";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";

const PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";
const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

function propertyCount(schema) {
  return schema && typeof schema.properties === "object" ? Object.keys(schema.properties).length : 0;
}

/**
 * Models tab: list, JSON schema editor with validation, delete, and
 * "generate from sample JSON". Data operations go through `onCreate`,
 * `onUpdate`, `onDelete` (management API); `models` is the current list.
 */
export function ModelsTab({ models = [], loading = false, error = null, onCreate, onUpdate, onDelete, canWrite = false }) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  if (loading) return <LoadingArea panel label="Loading models" />;
  if (error) return <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={Database} title="Could not load models" description={String(error?.message ?? error)} /></div>;

  const open = (model) => (canWrite ? setEditing(model) : setViewing(model));

  const columns = [
    {
      key: "name",
      header: "Model",
      render: (model) => <div className="min-w-0">
        <span className="font-medium text-foreground">{model.name}</span>
        {model.description ? <p className="mt-0.5 max-w-[26rem] truncate text-xs text-text-secondary">{model.description}</p> : null}
      </div>,
    },
    {
      key: "type",
      header: "Type",
      render: (model) => (model.schema?.type ? <Badge variant="outline">{String(model.schema.type)}</Badge> : <span className="text-xs text-text-tertiary">—</span>),
    },
    {
      key: "contentType",
      header: "Content type",
      render: (model) => <span className="font-mono text-xs text-text-secondary">{model.contentType}</span>,
    },
    {
      key: "properties",
      header: "Properties",
      align: "right",
      className: "text-right text-sm tabular-nums text-text-secondary",
      render: (model) => propertyCount(model.schema),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (model) => <ActionMenu
        label={`Actions for ${model.name}`}
        items={canWrite ? [
          { icon: Pencil, label: "Edit", onSelect: () => setEditing(model) },
          { separator: true },
          { icon: Trash2, label: "Delete", destructive: true, onSelect: () => setDeleteTarget(model) },
        ] : [
          { icon: Eye, label: "View schema", onSelect: () => setViewing(model) },
        ]}
      />,
    },
  ];

  return <div className="space-y-8">
    <SectionCard
      bare
      title="Models"
      description="JSON Schema (draft-04) documents that validate request bodies and describe payloads in generated SDKs."
      action={canWrite ? <Button size="sm" className={PRIMARY} onClick={() => setCreating(true)}><Plus className="size-4" />New Model</Button> : null}
    >
      <DataTable
        columns={columns}
        data={models}
        getRowKey={(model) => model.id ?? model.name}
        onRowClick={open}
        empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
          icon={Database}
          title="No models yet"
          description={canWrite ? "Create one to validate request bodies." : "Models validate request bodies and describe payloads."}
          action={canWrite ? <Button className={PRIMARY} onClick={() => setCreating(true)}><Plus className="size-4" />New Model</Button> : null}
        /></div>}
      />
    </SectionCard>

    <Dialog open={creating} onOpenChange={setCreating}>
      <DialogContent className="max-w-xl bg-background">
        <DialogHeader>
          <DialogTitle>New Model</DialogTitle>
          <DialogDescription>Write a schema by hand or generate one from a sample payload.</DialogDescription>
        </DialogHeader>
        {creating ? <ModelForm onCancel={() => setCreating(false)} onSubmit={async (input) => { await onCreate?.(input); setCreating(false); }} /> : null}
      </DialogContent>
    </Dialog>

    <Dialog open={Boolean(editing)} onOpenChange={(open) => { if (!open) setEditing(null); }}>
      <DialogContent className="max-w-xl bg-background">
        <DialogHeader>
          <DialogTitle>Edit {editing?.name}</DialogTitle>
          <DialogDescription>Changes apply to every method request that references this model.</DialogDescription>
        </DialogHeader>
        {editing ? <ModelForm key={editing.id ?? editing.name} initial={editing} submitLabel="Save Changes" onCancel={() => setEditing(null)} onSubmit={async (input) => { await onUpdate?.(editing, input); setEditing(null); }} /> : null}
      </DialogContent>
    </Dialog>

    <Dialog open={Boolean(viewing)} onOpenChange={(open) => { if (!open) setViewing(null); }}>
      <DialogContent className="max-w-xl bg-background">
        <DialogHeader>
          <DialogTitle>{viewing?.name}</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{viewing?.contentType}</span>
            {viewing?.description ? ` · ${viewing.description}` : ""}
          </DialogDescription>
        </DialogHeader>
        <pre className="max-h-96 overflow-auto rounded-lg border border-border bg-surface-subtle p-3 font-mono text-xs text-text-secondary">{JSON.stringify(viewing?.schema, null, 2)}</pre>
        <DialogFooter>
          <Button variant="outline" className={SECONDARY} onClick={() => setViewing(null)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete model</DialogTitle>
          <DialogDescription>
            Delete <span className="font-medium text-foreground">{deleteTarget?.name}</span>? Methods that reference it will no longer validate against it. This can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button className="bg-red-500/90 text-white hover:bg-red-500" onClick={() => { const model = deleteTarget; setDeleteTarget(null); onDelete?.(model); }}><Trash2 className="size-4" />Delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

export function ModelForm({ initial, submitLabel = "Create Model", onSubmit, onCancel }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [contentType, setContentType] = useState(initial?.contentType ?? "application/json");
  const [schemaText, setSchemaText] = useState(JSON.stringify(initial?.schema ?? { type: "object" }, null, 2));
  const [sampleText, setSampleText] = useState("");
  const [schemaError, setSchemaError] = useState(null);
  const [saving, setSaving] = useState(false);

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
    setSaving(true);
    try {
      await onSubmit?.({ name, contentType, schema, description: initial?.description ?? "" });
    } catch (error) {
      toast.error(String(error?.message ?? error));
    } finally {
      setSaving(false);
    }
  }

  return <div className="space-y-4">
    <div className={initial ? "grid gap-4" : "grid gap-4 sm:grid-cols-2"}>
      {!initial ? <Field label="Name" hint="Letters and digits, up to 128." htmlFor="model-name">
        <Input id="model-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Order" autoFocus />
      </Field> : null}
      <Field label="Content type" htmlFor="model-content-type">
        <Input id="model-content-type" value={contentType} onChange={(event) => setContentType(event.target.value)} className="font-mono" />
      </Field>
    </div>
    <Field label="Schema" hint="JSON Schema draft-04." htmlFor="model-schema">
      <Textarea id="model-schema" className="font-mono text-xs" rows={10} value={schemaText} onChange={(event) => setSchemaText(event.target.value)} spellCheck={false} />
    </Field>
    <Field label="Generate from sample JSON" hint="Paste an example payload to infer a schema." htmlFor="model-sample">
      <Textarea id="model-sample" className="font-mono text-xs" rows={4} value={sampleText} onChange={(event) => setSampleText(event.target.value)} placeholder='{"name": "Ada", "age": 36}' spellCheck={false} />
    </Field>
    <Button type="button" size="sm" variant="outline" className={SECONDARY} onClick={generateFromSample}><Wand2 className="size-4" />Generate Schema</Button>
    {schemaError ? <p className="text-sm text-red-500">{schemaError}</p> : null}
    <div className="flex justify-end gap-2 pt-2">
      <Button type="button" variant="outline" className={SECONDARY} onClick={onCancel}>Cancel</Button>
      <Button type="button" className={PRIMARY} disabled={saving} onClick={submit}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {submitLabel}
      </Button>
    </div>
  </div>;
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
