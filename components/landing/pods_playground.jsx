"use client";

import { SidebarProvider } from "@geiger/ui/sidebar";
import { WorkspaceShell } from "@/components/internal/workspace/workspace_shell";
import { ProjectScreen } from "@/components/internal/screens/registry";
import { PlaygroundSessionProvider } from "@/context/session-context";
import { PlaygroundProjectProvider } from "@/context/project-context";
import { RbacProvider } from "@/context/rbac-context";
import { MemoryWorkspaceNav, useWorkspaceNav } from "@/context/workspace-nav-context";
import { PLAYGROUND_PROJECT, PLAYGROUND_USER } from "@/lib/workspace/playground.mjs";

// Live, embeddable copy of the Pods workspace for the landing page (like geiger-flow's FlowPlayground):
// the same WorkspaceShell and screens as /project, on a demonstrator project, with navigation kept in memory.

function PlaygroundScreen() {
  const { section } = useWorkspaceNav();
  return <ProjectScreen section={section} />;
}

export function PodsPlayground() {
  return <PlaygroundSessionProvider user={PLAYGROUND_USER}>
    <PlaygroundProjectProvider project={PLAYGROUND_PROJECT}>
      <RbacProvider>
        <MemoryWorkspaceNav projectId={PLAYGROUND_PROJECT.id}>
          <SidebarProvider className="!flex h-full w-full min-w-0 flex-col overflow-hidden bg-background font-sans text-foreground" style={{ flexDirection: "column" }}>
            <WorkspaceShell><PlaygroundScreen /></WorkspaceShell>
          </SidebarProvider>
        </MemoryWorkspaceNav>
      </RbacProvider>
    </PlaygroundProjectProvider>
  </PlaygroundSessionProvider>;
}

export default PodsPlayground;
