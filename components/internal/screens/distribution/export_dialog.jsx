"use client";

// Export dialog (S13 part A): pick stage, type, format, extensions and
// download the document generated from the deployed artifact.

import { useState } from "react";
import { Download } from "lucide-react";
import { EmptyState, SectionCard } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
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
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">Stage
          <select value={stage} onChange={(event) => setStage(event.target.value)} className="ml-1 rounded-md border border-border bg-background px-2 py-1 text-sm">
            {stages.map((entry) => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
          </select>
        </label>
        <label className="text-sm">Type
          <select value={type} onChange={(event) => setType(event.target.value)} className="ml-1 rounded-md border border-border bg-background px-2 py-1 text-sm">
            <option value="oas30">OpenAPI 3.0</option>
            <option value="swagger">Swagger 2.0</option>
          </select>
        </label>
        <label className="text-sm">Format
          <select value={format} onChange={(event) => setFormat(event.target.value)} className="ml-1 rounded-md border border-border bg-background px-2 py-1 text-sm">
            <option value="json">JSON</option>
            <option value="yaml">YAML</option>
          </select>
        </label>
        <label className="text-sm">Extensions
          <select value={extensions} onChange={(event) => setExtensions(event.target.value)} className="ml-1 rounded-md border border-border bg-background px-2 py-1 text-sm">
            <option value="aws">AWS (round-trips to AWS)</option>
            <option value="pods">Pods</option>
            <option value="none">None</option>
            <option value="postman">Postman v2.1</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={includeDocs} onChange={(event) => setIncludeDocs(event.target.checked)} />
          Include docs
        </label>
        <Button disabled={busy} onClick={onExport}>Download</Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Exports render the deployed artifact, never the draft.</p>
    </SectionCard>
  );
}
