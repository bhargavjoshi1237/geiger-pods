"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { resolveSection } from "@/lib/workspace/model.mjs";

// Where the workspace is and how it moves: the URL under /project, or local state in the landing playground.
const WorkspaceNavContext = createContext(null);

const sectionHref = (projectId, section) => `/project/${encodeURIComponent(projectId)}/${section}`;

export function RouteWorkspaceNav({ children }) {
  const { projectId, rest } = useParams();
  const router = useRouter();
  const section = resolveSection(rest);
  const value = useMemo(() => ({
    memory: false, projectId, section,
    hrefFor: (slug) => sectionHref(projectId, slug),
    navigate: (slug) => router.push(sectionHref(projectId, slug)),
  }), [projectId, section, router]);
  return <WorkspaceNavContext.Provider value={value}>{children}</WorkspaceNavContext.Provider>;
}

export function MemoryWorkspaceNav({ projectId, initialSection = "overview", children }) {
  const [section, setSection] = useState(initialSection);
  const navigate = useCallback((slug) => setSection(slug), []);
  const value = useMemo(() => ({
    memory: true, projectId, section,
    hrefFor: (slug) => sectionHref(projectId, slug),
    navigate,
  }), [projectId, section, navigate]);
  return <WorkspaceNavContext.Provider value={value}>{children}</WorkspaceNavContext.Provider>;
}

export function useWorkspaceNav() {
  const value = useContext(WorkspaceNavContext);
  if (!value) throw new Error("useWorkspaceNav requires a workspace nav provider");
  return value;
}

// A link to a workspace section: a real route link, or an in-place switch in memory mode.
export function WorkspaceLink({ section, onClick, ...props }) {
  const { memory, hrefFor, navigate } = useWorkspaceNav();
  if (!memory) return <Link href={hrefFor(section)} onClick={onClick} {...props} />;
  return <a href={hrefFor(section)} {...props} onClick={(event) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    navigate(section);
  }} />;
}
