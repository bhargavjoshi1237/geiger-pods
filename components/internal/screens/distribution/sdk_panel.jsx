"use client";

// SDKs panel (S13 part C): language picker, config form, generate + download.
import { useState } from "react";
import { Loader2, Package } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { fetchApis } from "../apis/api_list";

const LANGUAGES = ["javascript", "typescript", "python", "java", "android", "swift", "ruby", "go", "kotlin"];

export function SdkPanel({ api, stages }) {
  const { project } = useProject();
  const { can } = useRbac();
  const apiRef = api.publicId ?? api.id;
  const [language, setLanguage] = useState("typescript");
  const [packageName, setPackageName] = useState("pods-client");
  const [version, setVersion] = useState("0.1.0");
  const [stageName, setStageName] = useState(stages?.[0]?.name ?? "");
  const [busy, setBusy] = useState(false);
  const canGenerate = can("pods.sdk.generate");

  const generate = async () => {
    if (!stageName) {
      toast.error("Pick a deployed stage first.");
      return;
    }
    setBusy(true);
    try {
      const job = await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/stages/${encodeURIComponent(stageName)}/sdks`, {
        method: "POST",
        body: JSON.stringify({ language, config: { packageName, version } }),
      });
      toast.success(`SDK generated (${job.files?.length ?? 0} files). Downloading zip.`);
      const response = await fetch(
        `/api/v1/projects/${encodeURIComponent(project.id)}/apis/${encodeURIComponent(apiRef)}/sdks/${encodeURIComponent(job.id)}`,
        { credentials: "same-origin" },
      );
      if (!response.ok) throw new Error(`Download failed (${response.status}).`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${language}-sdk-${String(job.id).slice(0, 8)}.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  if (!canGenerate) {
    return <SectionCard><EmptyState icon={Package} title="Access unavailable" description="Your current team access does not allow SDK generation." /></SectionCard>;
  }

  return (
    <div className="space-y-4">
      <ScreenHeader title="SDKs" description="Generate a client from the deployed stage (never the draft). TypeScript compiles with tsc; extended languages render via OpenAPI Generator." />
      <SectionCard>
        {(stages ?? []).length === 0
          ? <EmptyState icon={Package} title="No stages yet" description="Deploy a stage first, then generate an SDK from it." />
          : (
            <div className="grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap">
              <Select value={stageName} onValueChange={setStageName}>
                <SelectTrigger className="sm:w-40" aria-label="Stage"><SelectValue /></SelectTrigger>
                <SelectContent>{(stages ?? []).map((entry) => <SelectItem key={entry.name} value={entry.name}>{entry.name}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={language} onValueChange={setLanguage}>
                <SelectTrigger className="sm:w-40" aria-label="Language"><SelectValue /></SelectTrigger>
                <SelectContent>{LANGUAGES.map((entry) => <SelectItem key={entry} value={entry}>{entry}</SelectItem>)}</SelectContent>
              </Select>
              <Input value={packageName} onChange={(event) => setPackageName(event.target.value)} placeholder="package name" className="sm:w-48" aria-label="Package name" spellCheck={false} />
              <Input value={version} onChange={(event) => setVersion(event.target.value)} placeholder="0.1.0" className="sm:w-24" aria-label="Version" spellCheck={false} />
              <Button className="col-span-2 sm:col-span-1" disabled={busy} onClick={generate}>{busy ? <Loader2 className="size-4 animate-spin" aria-label="Generating" /> : "Generate & download"}</Button>
            </div>
          )}
      </SectionCard>
    </div>
  );
}
