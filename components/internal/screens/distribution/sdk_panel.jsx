"use client";

// SDKs panel (S13 part C): language picker, config form, generate + download.
import { useState } from "react";
import { Package } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
import { LogoLoading } from "@geiger/ui/logo-loading";
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
            <div className="flex flex-wrap items-center gap-2">
              <select value={stageName} onChange={(event) => setStageName(event.target.value)} className="rounded-md border border-border bg-background px-2 py-1 text-sm" aria-label="Stage">
                {(stages ?? []).map((entry) => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
              </select>
              <select value={language} onChange={(event) => setLanguage(event.target.value)} className="rounded-md border border-border bg-background px-2 py-1 text-sm" aria-label="Language">
                {LANGUAGES.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
              </select>
              <input value={packageName} onChange={(event) => setPackageName(event.target.value)} placeholder="package name" className="rounded-md border border-border bg-background px-2 py-1 text-sm" aria-label="Package name" />
              <input value={version} onChange={(event) => setVersion(event.target.value)} placeholder="0.1.0" className="w-24 rounded-md border border-border bg-background px-2 py-1 text-sm" aria-label="Version" />
              <Button disabled={busy} onClick={generate}>{busy ? <LogoLoading /> : "Generate & download"}</Button>
            </div>
          )}
      </SectionCard>
    </div>
  );
}
