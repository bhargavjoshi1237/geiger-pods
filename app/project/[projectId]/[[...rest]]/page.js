"use client";

import { redirect, useParams } from "next/navigation";
import { resolveScreen } from "@/lib/workspace/screens.mjs";
import { ProjectScreen } from "@/components/internal/screens/registry";
import NotFound from "@/app/not-found";

// Client page (like geiger-events): the screen resolves from the URL in the
// browser, so a sidebar switch swaps screens without a server round trip.
export default function ProjectPage() {
  const { projectId, rest } = useParams();
  const segments = Array.isArray(rest) ? rest : rest ? [rest] : [];
  // The sidebar links to /overview; the bare project URL is just an alias for it.
  if (!segments.length) redirect(`/project/${encodeURIComponent(projectId)}/overview`);
  const match = resolveScreen(segments);
  if (!match) return <NotFound />;
  return <ProjectScreen section={match.section} screen={match.screen} params={match.params} />;
}
