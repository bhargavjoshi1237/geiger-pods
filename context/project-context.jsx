"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "./session-context";
import { createClient } from "@/lib/supabase/client";
import { listAccessibleProjects } from "@/lib/supabase/projects";
import { LAST_PROJECT_KEY } from "@/lib/workspace/model.mjs";

const ProjectContext = createContext(null);

function UserProjects({ children }) {
  const { user, status } = useSession();
  const router = useRouter();
  const { projectId = null } = useParams();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ projects: [], loading: true, error: null });

  useEffect(() => {
    if (status !== "authenticated") return;
    let alive = true;
    listAccessibleProjects(createClient(), user.id).then((projects) => {
      if (alive) setState({ projects, loading: false, error: null });
    }).catch((error) => {
      if (alive) setState({ projects: [], loading: false, error: error.message });
    });
    return () => { alive = false; };
  }, [user?.id, status, attempt]);

  const project = state.projects.find((p) => p.id === projectId) ?? null;
  useEffect(() => {
    if (project) {
      try { localStorage.setItem(LAST_PROJECT_KEY, project.id); } catch { /* Storage is optional. */ }
    }
  }, [project]);

  const refresh = useCallback(() => {
    setState({ projects: [], loading: true, error: null });
    setAttempt((value) => value + 1);
  }, []);
  const setActiveProject = useCallback((id) => {
    if (state.projects.some((p) => p.id === id)) router.push(`/project/${encodeURIComponent(id)}`);
  }, [state.projects, router]);
  const value = useMemo(() => ({ ...state, project, projectId, refresh, setActiveProject }), [state, project, projectId, refresh, setActiveProject]);
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function ProjectProvider({ children }) {
  const { user, status } = useSession();
  return <UserProjects key={`${status}:${user?.id ?? "none"}`}>{children}</UserProjects>;
}

// Single fixed project for the landing playground; no fetch, no remembered-project write.
export function PlaygroundProjectProvider({ project, children }) {
  const value = useMemo(() => ({
    projects: [project], project, projectId: project.id, loading: false, error: null,
    refresh: () => {}, setActiveProject: () => {},
  }), [project]);
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject() {
  const value = useContext(ProjectContext);
  if (!value) throw new Error("useProject requires ProjectProvider");
  return value;
}
