"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useProject } from "@/context/project-context";
import { LAST_PROJECT_KEY, pickDefaultProjectId } from "@/lib/workspace/model.mjs";
import { WorkspaceGate, LoadingArea } from "@/components/internal/workspace/workspace_states";

function ProjectResolver() {
  const { projects, loading, error } = useProject();
  const router = useRouter();
  useEffect(() => {
    if (loading || error || !projects.length) return;
    let remembered = null;
    try { remembered = localStorage.getItem(LAST_PROJECT_KEY); } catch { /* Storage is optional. */ }
    const id = pickDefaultProjectId(projects, remembered);
    if (id) router.replace(`/project/${encodeURIComponent(id)}`);
  }, [projects, loading, error, router]);
  return <LoadingArea label="Opening your project" />;
}

export default function ProjectIndexPage() {
  return <WorkspaceGate requireProject={false}><ProjectResolver /></WorkspaceGate>;
}
