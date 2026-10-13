"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { resolveScreen } from "@/lib/workspace/screens.mjs";

// Where the workspace is and how it moves: the URL under /project, or local state in the landing playground.
const WorkspaceNavContext = createContext(null);

const sectionHref = (projectId, section) => `/project/${encodeURIComponent(projectId)}/${section}`;

export function RouteWorkspaceNav({ children }) {
  const { projectId, rest } = useParams();
  const router = useRouter();
  // Nested paths (apis/:id/:tab, monitoring/logs…) still belong to a section
  // and a screen, so the sidebar keeps the right destination lit.
  const match = resolveScreen(Array.isArray(rest) ? rest : rest ? [rest] : []);
  const section = match?.section ?? null;
  const screen = match?.screen ?? null;
  const value = useMemo(() => ({
    memory: false, projectId, section, screen,
    hrefFor: (slug) => sectionHref(projectId, slug),
    navigate: (slug) => router.push(sectionHref(projectId, slug), { scroll: false }),
  }), [projectId, section, screen, router]);
  return <WorkspaceNavContext.Provider value={value}>{children}</WorkspaceNavContext.Provider>;
}

// Workspace path segments for an in-memory location ("apis/k1/routes" -> ["apis", "k1", "routes"]).
function pathSegments(path) {
  return String(path ?? "").split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

// The landing playground's navigation: any workspace path (`apis/:apiId/:tab`,
// `monitoring/alarms`…) kept in state instead of the URL. `rest` matches the
// `[[...rest]]` segments the /project route resolves with resolveScreen().
export function MemoryWorkspaceNav({ projectId, initialSection = "overview", children }) {
  const [rest, setRest] = useState(() => (initialSection === "overview" ? [] : pathSegments(initialSection)));
  const navigate = useCallback((slug) => {
    const next = pathSegments(slug);
    setRest(next.length === 1 && next[0] === "overview" ? [] : next);
  }, []);
  const match = resolveScreen(rest);
  const section = match?.section ?? null;
  const screen = match?.screen ?? null;
  const value = useMemo(() => ({
    memory: true, projectId, section, screen, rest,
    hrefFor: (slug) => sectionHref(projectId, slug),
    navigate,
  }), [projectId, section, screen, rest, navigate]);
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
