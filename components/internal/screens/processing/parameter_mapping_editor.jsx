"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Field } from "@/components/internal/shared/screen_kit";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";

const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

/**
 * HTTP parameter-mapping editor (AWS grammar): request table plus one
 * response table per backend status code. Rows are `{ key, value }` with
 * autocomplete of `$request`/`$response`/`$context`/`$stageVariables`
 * sources via the datalist.
 */
export function HttpMappingEditor({ request = {}, responses = {}, onChange }) {
  const [statusInput, setStatusInput] = useState("");

  function setRequest(rows) {
    onChange?.({ request: rows, responses });
  }

  function setResponses(next) {
    onChange?.({ request, responses: next });
  }

  const addStatus = () => {
    if (statusInput.trim()) {
      setResponses({ ...responses, [statusInput.trim()]: responses[statusInput.trim()] ?? {} });
      setStatusInput("");
    }
  };

  return (
    <div className="space-y-4">
      <MappingPanel title="Request mapping">
        <MappingTable
          rows={request}
          onChange={setRequest}
          keyPlaceholder="overwrite:header.X-Name"
          suggestions={["$request.header.", "$request.querystring.", "$request.body.", "$request.path", "$context.", "$stageVariables."]}
        />
      </MappingPanel>
      <MappingPanel title="Response mapping" description="One table per backend status code.">
        <div className="flex gap-2">
          <Input value={statusInput} onChange={(event) => setStatusInput(event.target.value)} placeholder="e.g. 500" aria-label="Backend status code" className="w-32 font-mono" />
          <Button type="button" variant="outline" size="sm" className={`h-9 ${SECONDARY}`} onClick={addStatus}><Plus className="size-4" />Add status</Button>
        </div>
        {Object.keys(responses ?? {}).length === 0 ? <p className="text-xs text-text-secondary">No per-status response mappings yet.</p> : null}
        {Object.entries(responses ?? {}).map(([status, table]) => (
          <div key={status} className="space-y-3 border-t border-border pt-4">
            <p className="text-sm font-medium text-foreground">Backend status <span className="font-mono">{status}</span></p>
            <MappingTable
              rows={table}
              onChange={(rows) => setResponses({ ...responses, [status]: rows })}
              keyPlaceholder="overwrite:statuscode"
              suggestions={["$response.header.", "$response.body.", "$context.", "$stageVariables."]}
            />
          </div>
        ))}
      </MappingPanel>
    </div>
  );
}

function MappingPanel({ title, description, children }) {
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

/**
 * REST mapping-table editor: integration-request and method-response
 * `source → target` rows with source autocomplete.
 */
export function RestMappingEditor({ title, description, rows = {}, onChange, keyPlaceholder, suggestions }) {
  return (
    <MappingPanel title={title} description={description}>
      <MappingTable rows={rows} onChange={(next) => onChange?.(next)} keyPlaceholder={keyPlaceholder} suggestions={suggestions} />
    </MappingPanel>
  );
}

export function MappingTable({ rows = {}, onChange, keyPlaceholder, suggestions = [] }) {
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const listId = `mapping-suggest-${(keyPlaceholder ?? "k").replace(/[^a-z0-9]+/gi, "")}`;

  function commit() {
    if (!newKey.trim()) return;
    onChange?.({ ...rows, [newKey.trim()]: newValue });
    setNewKey("");
    setNewValue("");
  }

  return (
    <div className="space-y-3">
      {Object.keys(rows ?? {}).length === 0 ? <p className="text-xs text-text-secondary">No mappings yet.</p> : <div className="divide-y divide-border rounded-lg border border-border">
        {Object.entries(rows ?? {}).map(([key, value]) => (
          <div key={key} className="flex items-center gap-2 px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={key}>{key}</code>
            <span className="text-text-tertiary">=</span>
            <Input className="h-8 flex-1 font-mono text-xs" value={value} aria-label={`Mapping value for ${key}`} onChange={(event) => onChange?.({ ...rows, [key]: event.target.value })} list={listId} />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${key}`}
              className="text-text-secondary hover:bg-surface-active hover:text-foreground"
              onClick={() => { const next = { ...rows }; delete next[key]; onChange?.(next); }}
            ><X className="size-4" /></Button>
          </div>
        ))}
      </div>}
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-center">
        <Input value={newKey} onChange={(event) => setNewKey(event.target.value)} placeholder={keyPlaceholder ?? "mapping key"} aria-label="New mapping key" className="font-mono text-xs" />
        <Input value={newValue} onChange={(event) => setNewValue(event.target.value)} placeholder="$request.header.id or 'static'" aria-label="New mapping value" list={listId} className="font-mono text-xs" />
        <Button type="button" variant="outline" size="sm" className={`h-9 ${SECONDARY}`} onClick={commit}><Plus className="size-4" />Add</Button>
      </div>
      <datalist id={listId}>
        {suggestions.map((suggestion) => <option key={suggestion} value={suggestion} />)}
      </datalist>
      <p className="text-xs text-text-tertiary">Wrap static strings in single quotes. Removals apply first, then overwrites, then appends.</p>
    </div>
  );
}

export function PassthroughPicker({ value, onChange }) {
  return (
    <Field label="Passthrough behavior" htmlFor="passthrough">
      <Select value={value ?? "WHEN_NO_MATCH"} onValueChange={(next) => onChange?.(next)}>
        <SelectTrigger id="passthrough" className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="WHEN_NO_MATCH">When no template matches — pass the body through</SelectItem>
          <SelectItem value="WHEN_NO_TEMPLATES">Only when no templates exist</SelectItem>
          <SelectItem value="NEVER">Never — reject unmatched content types (415)</SelectItem>
        </SelectContent>
      </Select>
    </Field>
  );
}
