"use client";

import { useMemo, useState } from "react";
import { SectionCard } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
import { Label } from "@geiger/ui/label";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";

/**
 * VTL template editor: monospace editing surface, a "Test template" box
 * that evaluates the template against a sample body/params/context, and a
 * "Generate from model" helper that scaffolds `$input.path` selections.
 * Standalone — the orchestrator mounts it in the REST method panel later.
 *
 * `evaluate` is injected by the host (server render in production); without
 * it the test box explains that evaluation needs the gateway build.
 */
export function TemplateEditor({ contentType, value, onChange, evaluate, models = [] }) {
  const [sampleBody, setSampleBody] = useState('{"name": " Ada "}');
  const [result, setResult] = useState(null);

  async function runTest() {
    if (!evaluate) {
      toast.error("Template evaluation needs the gateway build (S05 wiring).");
      return;
    }
    try {
      setResult({ output: await evaluate(value ?? "", { bodyText: sampleBody }) });
    } catch (error) {
      setResult({ error: String(error?.message ?? error) });
    }
  }

  const tokens = useMemo(() => highlightTokens(value ?? ""), [value]);

  return (
    <SectionCard title={contentType ? `Mapping template — ${contentType}` : "Mapping template"}>
      <div className="grid gap-3">
        <div>
          <Label htmlFor="template-body">Template (Velocity-compatible)</Label>
          <Textarea id="template-body" className="font-mono text-xs" rows={12} value={value ?? ""} onChange={(event) => onChange?.(event.target.value)} spellCheck={false} />
          <TemplatePreview tokens={tokens} />
        </div>
        {models.length > 0 ? (
          <div>
            <Label htmlFor="template-model">Generate from model</Label>
            <div className="flex gap-2">
              <select id="template-model" className="flex-1 rounded border p-2 text-sm" defaultValue={models[0]?.name} data-testid="template-model-select">
                {models.map((model) => <option key={model.name} value={model.name}>{model.name}</option>)}
              </select>
              <Button type="button" onClick={() => onChange?.(generateFromModel(models[0]))}>Insert scaffold</Button>
            </div>
          </div>
        ) : null}
        <div>
          <Label htmlFor="template-sample">Test template — sample body</Label>
          <Textarea id="template-sample" className="font-mono text-xs" rows={4} value={sampleBody} onChange={(event) => setSampleBody(event.target.value)} spellCheck={false} />
          <div className="mt-2 flex gap-2">
            <Button type="button" onClick={runTest}>Test template</Button>
          </div>
          {result?.output !== undefined ? <pre className="mt-2 overflow-auto rounded bg-muted p-2 font-mono text-xs">{result.output}</pre> : null}
          {result?.error ? <p className="mt-2 text-sm text-red-600">{result.error}</p> : null}
        </div>
      </div>
    </SectionCard>
  );
}

/** Scaffold that reads every top-level property of a model's schema. */
export function generateFromModel(model) {
  const properties = model?.schema?.properties ? Object.keys(model.schema.properties) : [];
  if (properties.length === 0) return "#set($root = $input.path('$'))\n$input.json('$')";
  return properties.map((name) => `#set($${name} = $input.path('$.${name}'))`).join("\n");
}

/** Lightweight tokenizer for syntax highlighting (refs/directives/comments). */
export function highlightTokens(template) {
  const tokens = [];
  const pattern = /(\$!?\{?[\w.[\]()'",\s$!=<>|&+\-*/%:?]*\}?|#[a-z]+(?:\([^)]*\))?|##[^\n]*|#\*[\s\S]*?\*#)/g;
  let last = 0;
  let match = pattern.exec(template);
  while (match) {
    if (match.index > last) tokens.push({ kind: "text", value: template.slice(last, match.index) });
    const value = match[0];
    tokens.push({ kind: value.startsWith("#") ? "directive" : "ref", value });
    last = match.index + value.length;
    match = pattern.exec(template);
  }
  if (last < template.length) tokens.push({ kind: "text", value: template.slice(last) });
  return tokens;
}

export function TemplatePreview({ tokens = [] }) {
  if (tokens.length === 0) return null;
  return (
    <pre className="mt-2 overflow-auto rounded bg-muted p-2 font-mono text-xs" aria-label="Syntax preview">
      {tokens.map((token, index) => (
        <span key={index} className={token.kind === "ref" ? "text-blue-600" : token.kind === "directive" ? "text-purple-700" : undefined}>
          {token.value}
        </span>
      ))}
    </pre>
  );
}
