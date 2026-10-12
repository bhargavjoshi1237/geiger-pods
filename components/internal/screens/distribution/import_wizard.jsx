"use client";

// Import wizard (S13 part A): upload/paste an OpenAPI 2.0/3.x document,
// pick overwrite/merge + options, preview warnings via dry-run, confirm.

import { useState } from "react";
import { FileUp, Loader2 } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
import { Checkbox } from "@geiger/ui/checkbox";
import { FileInput } from "@geiger/ui/file-input";
import { Label } from "@geiger/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { fetchApis } from "../apis/api_list";

export function ImportWizard({ api }) {
  const { project } = useProject();
  const { can } = useRbac();
  const apiRef = api.publicId ?? api.id;
  const [text, setText] = useState("");
  const [mode, setMode] = useState("overwrite");
  const [failOnWarnings, setFailOnWarnings] = useState(false);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const canImport = can("pods.api.import");

  const callImport = async (dryRun) => {
    const query = new URLSearchParams({ mode, ...(failOnWarnings ? { failOnWarnings: "true" } : {}), ...(dryRun ? { dryRun: "true" } : {}) });
    return fetchApis(project.id, `/${encodeURIComponent(apiRef)}/import?${query}`, {
      method: "PUT",
      body: JSON.stringify({ document: text }),
    });
  };

  const onPreview = async () => {
    if (!text.trim()) {
      toast.error("Paste or upload a document first.");
      return;
    }
    setBusy(true);
    try {
      const result = await callImport(true);
      setPreview(result);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const onConfirm = async () => {
    setBusy(true);
    try {
      const result = await callImport(false);
      const summary = result.summary ?? {};
      toast.success(`Import ${result.mode}: +${summary.added ?? 0} ~${summary.updated ?? 0} -${summary.removed ?? 0}. Deploy to serve it.`);
      setPreview(null);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file) => {
    if (!file) return;
    if (file.size > 6 * 1024 * 1024) {
      toast.error("Document exceeds the 6 MB import limit.");
      return;
    }
    setText(await file.text());
  };

  if (!canImport) {
    return <SectionCard><EmptyState icon={FileUp} title="Access unavailable" description="Your current team access does not allow imports." /></SectionCard>;
  }

  return (
    <div className="space-y-4">
      <ScreenHeader title="Import OpenAPI" description="Overwrite or merge a Swagger 2.0 / OpenAPI 3.x document into the draft. A deploy is still required." />
      <SectionCard>
        <Label htmlFor="s13-import-text">Document (JSON or YAML)</Label>
        <Textarea
          id="s13-import-text"
          className="mt-2 min-h-40 font-mono text-xs"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder='{"swagger": "2.0", ...}'
          spellCheck={false}
        />
        <FileInput id="s13-import-file" accept=".json,.yaml,.yml" className="mt-2" aria-label="Upload document" onChange={(event) => onFile(event.target.files?.[0])} />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Select value={mode} onValueChange={setMode}>
            <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="Import mode"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="overwrite">Overwrite draft</SelectItem>
              <SelectItem value="merge">Merge into draft</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2">
            <Checkbox id="s13-import-fail-on-warnings" checked={failOnWarnings} onCheckedChange={(value) => setFailOnWarnings(value === true)} />
            <Label htmlFor="s13-import-fail-on-warnings" className="font-normal">Fail on warnings</Label>
          </div>
          <Button variant="outline" size="sm" disabled={busy} onClick={onPreview}>{busy ? <Loader2 className="size-4 animate-spin" aria-label="Previewing" /> : "Preview warnings"}</Button>
          <Button size="sm" disabled={busy || !text.trim()} onClick={onConfirm}>Confirm import</Button>
        </div>
      </SectionCard>
      {preview ? (
        <SectionCard>
          <h3 className="text-sm font-medium">Warnings preview ({preview.warnings?.length ?? 0})</h3>
          {(preview.warnings ?? []).length === 0
            ? <p className="mt-1 text-sm text-muted-foreground">No warnings. Safe to confirm.</p>
            : (
              <ul className="mt-2 space-y-1 text-sm">
                {(preview.warnings ?? []).slice(0, 50).map((warning, index) => (
                  <li key={index} className="rounded border border-border p-2 font-mono text-xs">
                    <span className="font-semibold">{warning.path}</span>: {warning.message}
                  </li>
                ))}
              </ul>
            )}
        </SectionCard>
      ) : null}
    </div>
  );
}
