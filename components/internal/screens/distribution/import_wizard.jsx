"use client";

// Import wizard: upload/paste an OpenAPI 2.0/3.x document, pick
// overwrite/merge + options, preview warnings via dry-run, confirm.

import { useState } from "react";
import { AlertTriangle, CheckCircle2, FileUp, Loader2 } from "lucide-react";
import { DataTable, EmptyState, Field, SectionCard, SettingRow, SettingsList } from "@/components/internal/shared/screen_kit";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { FileInput } from "@geiger/ui/file-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { fetchApis } from "../apis/api_list";

const PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";
const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

const WARNING_COLUMNS = [
  {
    key: "path",
    header: "Location",
    render: (warning) => <div className="flex items-start gap-2">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
      <span className="break-all font-mono text-xs font-medium text-foreground">{warning.path}</span>
    </div>,
  },
  { key: "message", header: "Warning", className: "text-xs text-text-secondary", render: (warning) => warning.message },
];

export function ImportWizard({ api }) {
  const { project } = useProject();
  const { can } = useRbac();
  const apiRef = api.publicId ?? api.id;
  const [text, setText] = useState("");
  const [mode, setMode] = useState("overwrite");
  const [failOnWarnings, setFailOnWarnings] = useState(false);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
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
      setConfirmOverwrite(false);
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

  const header = { title: "Import OpenAPI", description: "Overwrite or merge a Swagger 2.0 or OpenAPI 3.x document into the draft. Deploy afterwards to serve the changes." };

  if (!canImport) {
    return <SectionCard bare {...header}>
      <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={FileUp} title="Access unavailable" description="Your current team access does not allow imports." /></div>
    </SectionCard>;
  }

  const warnings = preview?.warnings ?? [];

  return <div className="space-y-8">
    <SectionCard bare {...header}>
      <div className="space-y-4">
        <Field label="Document" htmlFor="import-document" hint="Paste JSON or YAML, or upload a file below (up to 6 MB).">
          <Textarea
            id="import-document"
            className="min-h-40 font-mono text-xs"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder='{"swagger": "2.0", ...}'
            spellCheck={false}
          />
        </Field>
        <Field label="Upload a file" htmlFor="import-file">
          <FileInput id="import-file" accept=".json,.yaml,.yml" aria-label="Upload document" onChange={(event) => onFile(event.target.files?.[0])} />
        </Field>
        <SettingsList className="rounded-xl border border-border bg-surface-card p-4">
          <SettingRow
            title="Import mode"
            description="Overwrite replaces the draft with the document; merge combines the two."
            control={<Select value={mode} onValueChange={setMode}>
              <SelectTrigger size="sm" className="w-44 shrink-0" aria-label="Import mode"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="overwrite">Overwrite draft</SelectItem>
                <SelectItem value="merge">Merge into draft</SelectItem>
              </SelectContent>
            </Select>}
          />
          <SettingRow
            title="Fail on warnings"
            description="Stop the import if the document produces any warnings."
            checked={failOnWarnings}
            onCheckedChange={(value) => setFailOnWarnings(value === true)}
          />
        </SettingsList>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" size="sm" className={SECONDARY} disabled={busy} onClick={onPreview}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Preview Warnings</Button>
          <Button size="sm" className={PRIMARY} disabled={busy || !text.trim()} onClick={() => (mode === "overwrite" ? setConfirmOverwrite(true) : onConfirm())}><FileUp className="size-4" />Confirm Import</Button>
        </div>
      </div>
    </SectionCard>
    {preview ? <SectionCard bare title={`Warnings preview (${warnings.length})`} description="A dry run of the import. Nothing has changed yet.">
      {warnings.length === 0
        ? <div className="flex items-center gap-2 rounded-xl border border-border bg-surface-card px-4 py-3 text-sm text-text-secondary"><CheckCircle2 className="size-4 text-emerald-400" />No warnings. Safe to confirm.</div>
        : <div className="space-y-2">
          <DataTable columns={WARNING_COLUMNS} data={warnings.slice(0, 50)} getRowKey={(_, index) => index} />
          {warnings.length > 50 ? <p className="px-1 text-xs text-text-tertiary">Showing the first 50 of {warnings.length} warnings.</p> : null}
        </div>}
    </SectionCard> : null}

    <Dialog open={confirmOverwrite} onOpenChange={setConfirmOverwrite}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Overwrite draft</DialogTitle>
          <DialogDescription>
            Replace the draft of <span className="font-medium text-foreground">{api.name}</span> with this document? Its current routes, resources, integrations, models and authorizers are replaced. Deployed stages are unaffected until you deploy.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setConfirmOverwrite(false)}>Cancel</Button>
          <Button className="bg-red-500/90 text-white hover:bg-red-500" disabled={busy} onClick={onConfirm}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}Overwrite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
