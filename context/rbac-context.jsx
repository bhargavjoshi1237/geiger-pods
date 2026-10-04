"use client";

import { createContext, useContext, useMemo } from "react";
import { can, resolveGrants } from "@geiger/rbac";
import config from "@/geiger-rbac.config";
import { inheritedAuthorization } from "@/lib/workspace/access.mjs";
import { useSession } from "./session-context";
import { useProject } from "./project-context";

const RbacContext = createContext({ can: () => false });

export function RbacProvider({ children }) {
  const { user, status } = useSession();
  const { project, loading, error } = useProject();
  const value = useMemo(() => {
    const active = status === "authenticated" && !loading && !error && Boolean(project);
    const binding = inheritedAuthorization(active ? project.inheritedRole : null, user?.id, project?.id);
    const options = { config, ...binding, actorId: user?.id, resolved: resolveGrants({ config, ...binding }) };
    return { can: (permission) => active && can(permission, options) };
  }, [user?.id, status, project, loading, error]);
  return <RbacContext.Provider value={value}>{children}</RbacContext.Provider>;
}

export function useRbac() { return useContext(RbacContext); }
