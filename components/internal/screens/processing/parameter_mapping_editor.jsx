"use client";

import { useState } from "react";
import { ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";

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

  return (
    <div className="space-y-4">
      <ScreenHeader title="Parameter mapping" description="Map headers, query strings, paths and status codes with the AWS HTTP parameter-mapping grammar." />
      <SectionCard title="Request mapping">
        <MappingTable
          rows={request}
          onChange={setRequest}
          keyPlaceholder="overwrite:header.X-Name"
          suggestions={["$request.header.", "$request.querystring.", "$request.body.", "$request.path", "$context.", "$stageVariables."]}
        />
      </SectionCard>
      <SectionCard title="Response mapping (per backend status)">
        <div className="mb-2 flex gap-2">
          <Input value={statusInput} onChange={(event) => setStatusInput(event.target.value)} placeholder="e.g. 500" aria-label="Backend status code" />
          <Button type="button" onClick={() => { if (statusInput.trim()) { setResponses({ ...responses, [statusInput.trim()]: responses[statusInput.trim()] ?? {} }); setStatusInput(""); } }}>Add status</Button>
        </div>
        {Object.keys(responses ?? {}).length === 0 ? <p className="text-sm text-muted-foreground">No per-status response mappings yet.</p> : null}
        {Object.entries(responses ?? {}).map(([status, table]) => (
          <div key={status} className="mb-3 rounded border p-3">
            <p className="mb-2 text-sm font-medium">Backend status {status}</p>
            <MappingTable
              rows={table}
              onChange={(rows) => setResponses({ ...responses, [status]: rows })}
              keyPlaceholder="overwrite:statuscode"
              suggestions={["$response.header.", "$response.body.", "$context.", "$stageVariables."]}
            />
          </div>
        ))}
      </SectionCard>
    </div>
  );
}

/**
 * REST mapping-table editor: integration-request and method-response
 * `source → target` rows with source autocomplete.
 */
export function RestMappingEditor({ title, description, rows = {}, onChange, keyPlaceholder, suggestions }) {
  return (
    <SectionCard title={title}>
      {description ? <p className="mb-2 text-sm text-muted-foreground">{description}</p> : null}
      <MappingTable rows={rows} onChange={(next) => onChange?.(next)} keyPlaceholder={keyPlaceholder} suggestions={suggestions} />
    </SectionCard>
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
    <div className="space-y-2">
      {Object.keys(rows ?? {}).length === 0 ? <p className="text-sm text-muted-foreground">No mappings yet.</p> : null}
      {Object.entries(rows ?? {}).map(([key, value]) => (
        <div key={key} className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate text-xs">{key}</code>
          <span className="text-muted-foreground">=</span>
          <Input className="flex-1" value={value} aria-label={`Mapping value for ${key}`} onChange={(event) => onChange?.({ ...rows, [key]: event.target.value })} list={listId} />
          <Button type="button" variant="outline" onClick={() => { const next = { ...rows }; delete next[key]; onChange?.(next); }}>Remove</Button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Input value={newKey} onChange={(event) => setNewKey(event.target.value)} placeholder={keyPlaceholder ?? "mapping key"} aria-label="New mapping key" />
        <Input value={newValue} onChange={(event) => setNewValue(event.target.value)} placeholder="$request.header.id or 'static'" aria-label="New mapping value" list={listId} />
        <Button type="button" onClick={commit}>Add</Button>
      </div>
      <datalist id={listId}>
        {suggestions.map((suggestion) => <option key={suggestion} value={suggestion} />)}
      </datalist>
      <p className="text-xs text-muted-foreground">Static strings use single quotes. Remove runs before overwrite, overwrite before append.</p>
    </div>
  );
}

export function PassthroughPicker({ value, onChange }) {
  return (
    <div>
      <Label htmlFor="passthrough">Passthrough behavior</Label>
      <select id="passthrough" className="w-full rounded border p-2 text-sm" value={value ?? "WHEN_NO_MATCH"} onChange={(event) => onChange?.(event.target.value)}>
        <option value="WHEN_NO_MATCH">WHEN_NO_MATCH — pass through unmatched types</option>
        <option value="WHEN_NO_TEMPLATES">WHEN_NO_TEMPLATES — pass through only when no templates exist</option>
        <option value="NEVER">NEVER — reject unmatched types with 415</option>
      </select>
    </div>
  );
}
