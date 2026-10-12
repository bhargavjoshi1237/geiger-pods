"use client";

// Export dialog (S13 part A): pick stage, type, format, extensions and
// download the document generated from the deployed artifact.

import { useState } from "react";
import { Download } from "lucide-react";
import { EmptyState, Field, SectionCard } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
import { Checkbox } from "@geiger/ui/checkbox";
import { Label } from "@geiger/ui/label";
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
    return <SectionCard><EmptyState icon={Download} title="Access unavailable" description="Your current team access does not allow exports." /></SectionCard>;
  }
  if (!stages || stages.length === 0) {
    return <SectionCard><EmptyState icon={Download} title="No stages yet" description="Deploy the API to a stage before exporting." /></SectionCard>;
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

  return (
    <SectionCard>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
        <Field label="Extensions" htmlFor="export-extensions">
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
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Checkbox id="export-include-docs" checked={includeDocs} onCheckedChange={(value) => setIncludeDocs(value === true)} />
          <Label htmlFor="export-include-docs" className="font-normal">Include docs</Label>
        </div>
        <Button disabled={busy} onClick={onExport}>Download</Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Exports render the deployed artifact, never the draft.</p>
    </SectionCard>
  );
}
