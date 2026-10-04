import { notFound } from "next/navigation";
import { resolveSection } from "@/lib/workspace/model.mjs";
import { ProjectScreen } from "@/components/internal/screens/registry";

export default async function ProjectPage({ params }) {
  const { rest } = await params;
  const section = resolveSection(rest);
  if (!section) notFound();
  return <ProjectScreen section={section} />;
}
