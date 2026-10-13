"use client";

// Export: pick stage, type, format, extensions and download the document
// generated from the deployed artifact.

import { useState } from "react";
import { Download, Loader2, Rocket } from "lucide-react";
import { EmptyState, Field, SectionCard, SettingRow, SettingsList } from "@/components/internal/shared/screen_kit";
import { Button } from "@geiger/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { fetchApis } from "../apis/api_list";

function download(filename, text, contentType) {
  const blob = new Blob([text], { type: contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

const PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";

const HEADER = { title: "Export", description: "Download an OpenAPI or Postman document built from a stage's deployed snapshot, never the draft." };

export function ExportDialog({ api, stages }) {
  const { project } = useProject();
  const { can } = useRbac();
  const apiRef = api.publicId ?? api.id;
  const [stage, setStage] = useState(stages?.[0]?.name ?? "prod");
  const [type, setType] = useState("oas30");
  const [format, setFormat] = useState("json");
  const [extensions, setExtensions] = useState("aws");
  const [includeDocs, setIncludeDocs] = useState(true);
  const [busy, setBusy] = useState(false);
  const canExport = can("pods.api.export");

  if (!canExport) {
    return <SectionCard bare className="pt-4" {...HEADER}>
      <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={Download} title="Access unavailable" description="Your current team access does not allow exports." /></div>
    </SectionCard>;
  }
  if (!stages || stages.length === 0) {
    return <SectionCard bare className="pt-4" {...HEADER}>
      <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={Rocket} title="No stages yet" description="Deploy the API to a stage before exporting." /></div>
    </SectionCard>;
  }

  const onExport = async () => {
    setBusy(true);
    try {
      const query = new URLSearchParams({ type, format, extensions, includeDocs: String(includeDocs) });
      const result = await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/stages/${encodeURIComponent(stage)}/export?${query}`);
      const text = typeof result.document === "string" ? result.document : JSON.stringify(result.document, null, 2);
      const ext = extensions === "postman" ? "postman.json" : format === "yaml" ? "yaml" : "json";
      download(`${api.name}-${stage}.${ext}`, text, result.contentType ?? "application/json");
      toast.success(`Exported ${stage} (${extensions}).`);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <SectionCard bare className="pt-4" {...HEADER}>
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Stage" htmlFor="export-stage">
          <Select value={stage} onValueChange={setStage}>
            <SelectTrigger id="export-stage"><SelectValue /></SelectTrigger>
            <SelectContent>{stages.map((entry) => <SelectItem key={entry.name} value={entry.name}>{entry.name}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Type" htmlFor="export-type">
          <Select value={type} onValueChange={setType}>
            <SelectTrigger id="export-type"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="oas30">OpenAPI 3.0</SelectItem>
              <SelectItem value="swagger">Swagger 2.0</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Format" htmlFor="export-format">
          <Select value={format} onValueChange={setFormat}>
            <SelectTrigger id="export-format"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="json">JSON</SelectItem>
              <SelectItem value="yaml">YAML</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Extensions" htmlFor="export-extensions" hint="AWS extensions let the file round-trip into AWS API Gateway.">
          <Select value={extensions} onValueChange={setExtensions}>
            <SelectTrigger id="export-extensions"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="aws">AWS (round-trips to AWS)</SelectItem>
              <SelectItem value="pods">Pods</SelectItem>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="postman">Postman v2.1</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <SettingsList className="rounded-xl border border-border bg-surface-card p-4">
        <SettingRow
          title="Include documentation"
          description="Embed the stage's documentation parts in the exported file."
          checked={includeDocs}
          onCheckedChange={(value) => setIncludeDocs(value === true)}
        />
      </SettingsList>
      <div className="flex justify-end">
        <Button size="sm" className={PRIMARY} disabled={busy} onClick={onExport}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="size-4" />}{busy ? "Exporting…" : "Download"}</Button>
      </div>
    </div>
  </SectionCard>;
}
