"use client";

import { useMemo, useState } from "react";
import { FlaskConical, Wand2 } from "lucide-react";
import { Field } from "@/components/internal/shared/screen_kit";
import { Button } from "@geiger/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";

const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

/**
 * VTL template editor: monospace editing surface, a "Test template" box
 * that evaluates the template against a sample body/params/context, and a
 * "Generate from model" helper that scaffolds `$input.path` selections.
 *
 * `evaluate` is injected by the host; without it the test box explains that
 * evaluation isn't available in this view.
 */
export function TemplateEditor({ contentType, value, onChange, evaluate, models = [], action }) {
  const [sampleBody, setSampleBody] = useState('{"name": " Ada "}');
  const [result, setResult] = useState(null);
  const [modelName, setModelName] = useState(null);
  const scaffoldModel = models.find((model) => model.name === modelName) ?? models[0];

  async function runTest() {
    if (!evaluate) {
      toast.error("Template testing isn't available in this view yet.");
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
    <div className="space-y-4 rounded-xl border border-border bg-surface-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Mapping template{contentType ? <> · <span className="font-mono">{contentType}</span></> : null}</p>
          <p className="mt-0.5 text-xs text-text-secondary">Velocity-compatible template rendered for this content type.</p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <Field label="Template" htmlFor="template-body">
        <Textarea id="template-body" className="font-mono text-xs" rows={12} value={value ?? ""} onChange={(event) => onChange?.(event.target.value)} spellCheck={false} />
        <TemplatePreview tokens={tokens} />
      </Field>
      {models.length > 0 ? (
        <Field label="Generate from model" htmlFor="template-model">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={scaffoldModel?.name} onValueChange={setModelName}>
              <SelectTrigger id="template-model" className="w-auto min-w-40 flex-1" data-testid="template-model-select"><SelectValue /></SelectTrigger>
              <SelectContent>
                {models.map((model) => <SelectItem key={model.name} value={model.name}>{model.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button type="button" variant="outline" size="sm" className={`h-9 ${SECONDARY}`} onClick={() => onChange?.(generateFromModel(scaffoldModel))}><Wand2 className="size-4" />Insert Scaffold</Button>
          </div>
        </Field>
      ) : null}
      <div className="space-y-2 border-t border-border pt-4">
        <Field label="Test with a sample body" htmlFor="template-sample">
          <Textarea id="template-sample" className="font-mono text-xs" rows={4} value={sampleBody} onChange={(event) => setSampleBody(event.target.value)} spellCheck={false} />
        </Field>
        <Button type="button" variant="outline" size="sm" className={SECONDARY} onClick={runTest}><FlaskConical className="size-4" />Test Template</Button>
        {result?.output !== undefined ? <pre className="overflow-auto rounded-lg border border-border bg-surface-subtle p-3 font-mono text-xs text-foreground">{result.output}</pre> : null}
        {result?.error ? <p className="text-sm text-destructive-text">{result.error}</p> : null}
      </div>
    </div>
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
    <pre className="mt-2 overflow-auto rounded-lg border border-border bg-surface-subtle p-3 font-mono text-xs text-foreground" aria-label="Syntax preview">
      {tokens.map((token, index) => (
        <span key={index} className={token.kind === "ref" ? "text-blue-600 dark:text-blue-400" : token.kind === "directive" ? "text-purple-700 dark:text-purple-400" : undefined}>
          {token.value}
        </span>
      ))}
    </pre>
  );
}
