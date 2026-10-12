"use client";

import { useCallback } from "react";
import { SidebarProvider } from "@geiger/ui/sidebar";
import { WorkspaceShell } from "@/components/internal/workspace/workspace_shell";
import { ProjectScreen } from "@/components/internal/screens/registry";
import { ScreenErrorBoundary } from "@/components/landing/screen_error_boundary";
import { PlaygroundSessionProvider } from "@/context/session-context";
import { PlaygroundProjectProvider } from "@/context/project-context";
import { RbacProvider } from "@/context/rbac-context";
import { MemoryWorkspaceNav, useWorkspaceNav } from "@/context/workspace-nav-context";
import { resolveScreen } from "@/lib/workspace/screens.mjs";
import { usePlaygroundMode } from "@/lib/playground/use_playground_mode";
import { playgroundHandlers, playgroundRoutes } from "@/lib/playground/handlers";
import { PLAYGROUND_USER, PLAYGROUND_WORKSPACE_PROJECT } from "@/lib/playground/workspace";

// Live, embeddable copy of the Pods workspace for the landing page (served at
// /playground and iframed by the showcase): the same WorkspaceShell, sidebar
// and screens as /project, on Halcyon Studio's seeded gateway. Every
// /api/v1 call is answered from the in-memory seed (lib/playground), and
// navigation stays in memory, so nothing touches Supabase or the real API.

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";
const MODE_OPTIONS = { routes: playgroundRoutes, basePath: BASE_PATH };

// The API detail screen's tab links are relative to `apis/:apiId/:tab`, so the
// playground always lands on a tab, as the real URLs do.
function canonicalRest(rest) {
  const match = resolveScreen(rest);
  if (match?.screen === "apiDetail" && !match.params.tab) return [...rest, "overview"];
  return rest;
}

/**
 * Screens link to each other with plain relative anchors (`href="logs"`,
 * `./apis/:id`). In the playground those resolve against the virtual
 * `/project/:id/…` location and move the in-memory nav instead of the frame.
 */
function useWorkspaceAnchors() {
  const { projectId, rest, navigate } = useWorkspaceNav();
  return useCallback((event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target.closest?.("a[href]");
    if (!anchor || anchor.hasAttribute("download")) return;
    const href = anchor.getAttribute("href");
    if (!href || href.startsWith("#") || href.startsWith("blob:") || href.startsWith("mailto:")) return;
    const origin = "http://workspace.invalid";
    const prefix = `/project/${encodeURIComponent(projectId)}`;
    const here = `${prefix}/${canonicalRest(rest).map(encodeURIComponent).join("/")}`;
    let target = null;
    // Try the location as a directory first ("logs" from monitoring/ -> monitoring/logs), then as a file.
    for (const base of [`${here.replace(/\/$/, "")}/`, here]) {
      const url = new URL(href, `${origin}${base}`);
      if (url.origin !== origin) {
        event.preventDefault();
        window.open(url.href, "_blank", "noopener,noreferrer");
        return;
      }
      if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) continue;
      const segments = url.pathname.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent);
      if (resolveScreen(segments)) {
        target = segments;
        break;
      }
    }
    // Same-site pages outside the workspace (public portals, sign-in) don't exist in the playground.
    event.preventDefault();
    if (target) navigate(canonicalRest(target).map(encodeURIComponent).join("/"));
  }, [projectId, rest, navigate]);
}

function PlaygroundScreen() {
  const { rest } = useWorkspaceNav();
  const match = resolveScreen(canonicalRest(rest)) ?? resolveScreen([]);
  const key = rest.join("/") || "overview";
  return <ScreenErrorBoundary key={key} title={key}>
    <ProjectScreen section={match.section} screen={match.screen} params={match.params} />
  </ScreenErrorBoundary>;
}

function PlaygroundWorkspace() {
  const onClick = useWorkspaceAnchors();
  return <SidebarProvider className="!flex h-full w-full min-w-0 flex-col overflow-hidden bg-background font-sans text-foreground" style={{ flexDirection: "column" }} onClick={onClick}>
    <WorkspaceShell><PlaygroundScreen /></WorkspaceShell>
  </SidebarProvider>;
}

export function PodsPlayground() {
  usePlaygroundMode(playgroundHandlers, MODE_OPTIONS);
  return <PlaygroundSessionProvider user={PLAYGROUND_USER}>
    <PlaygroundProjectProvider project={PLAYGROUND_WORKSPACE_PROJECT}>
      <RbacProvider>
        <MemoryWorkspaceNav projectId={PLAYGROUND_WORKSPACE_PROJECT.id}>
          <PlaygroundWorkspace />
        </MemoryWorkspaceNav>
      </RbacProvider>
    </PlaygroundProjectProvider>
  </PlaygroundSessionProvider>;
}

export default PodsPlayground;
