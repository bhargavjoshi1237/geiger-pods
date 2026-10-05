import { notFound } from "next/navigation";
import { resolveScreen } from "@/lib/workspace/screens.mjs";
import { ProjectScreen } from "@/components/internal/screens/registry";

export default async function ProjectPage({ params }) {
  const { rest } = await params;
  const match = resolveScreen(rest);
  if (!match) notFound();
  return <ProjectScreen section={match.section} screen={match.screen} params={match.params} />;
}
