"use client";

import { useMemo } from "react";
import { Topbar } from "@geiger/ui/topbar";
import { SidebarInset, SidebarTrigger } from "@geiger/ui/sidebar";
import { ProfileDropdown } from "@/components/account/profile_dropdown";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { useSession } from "@/context/session-context";
import { useWorkspaceNav } from "@/context/workspace-nav-context";
import { productHref } from "@/lib/workspace/model.mjs";
import { AppSidebar } from "../sidebar/sidebar";
import { leafForScreen, visibleNav } from "../sidebar/sidebar_nav";
import { ActivityLine } from "../topbar/activity_line";
import { NotificationsBell } from "../topbar/notifications_bell";

// The workspace chrome, laid out as geiger-events' WorkspaceShell: suite
// topbar (mobile sidebar trigger, search over the nav, help, notifications,
// account, activity line), grouped sidebar, and the scrolling main area.
export function WorkspaceShell({ children }) {
  const { memory, projectId, screen, hrefFor, navigate } = useWorkspaceNav();
  const { can } = useRbac();
  const { user, status } = useSession();
  const { loading: projectLoading } = useProject();
  const nav = useMemo(() => visibleNav(can), [can]);
  const activeKey = leafForScreen(screen)?.path ?? null;
  const navLoading = !memory && (status === "loading" || projectLoading);
  // The landing playground fakes its session, so it gets no real account menu, bell or sign-out.
  const profile = memory ? null : user ? <ProfileDropdown user={user} /> : status === "loading" ? <div className="ml-1 size-8 rounded-full border border-border bg-surface-subtle" role="status" aria-label="Checking your Geiger session" /> : null;
  const notifications = memory || !user ? <span /> : <NotificationsBell />;

  return <>
    <Topbar
      label="Pods"
      logoSrc={productHref("/logo1.svg")}
      homeHref={productHref("/")}
      helpHref={memory ? undefined : projectId ? productHref(hrefFor("roadmap")) : productHref("/")}
      searchPlaceholder="Search Pods..."
      searchNav={nav}
      searchRecentsKey="geiger:pods:search-recents"
      onSearchSelect={(item) => item.path && navigate(item.path)}
      sidebarTrigger={<SidebarTrigger className="md:hidden -ml-2 text-foreground" />}
      notifications={notifications}
      profile={profile}
      activity={<ActivityLine />}
    />
    <div className="flex flex-1 overflow-hidden relative">
      <AppSidebar nav={nav} activeKey={activeKey} loading={navLoading} />
      <SidebarInset className="flex-1 flex flex-col h-full bg-transparent overflow-hidden relative border-none">
        <div className="absolute top-0 right-0 w-[500px] h-[300px] bg-white/[0.02] blur-[120px] pointer-events-none rounded-full"></div>
        <main id="workspace-content" className="flex-1 overflow-y-auto p-4 md:p-8 relative z-10 w-full min-w-0">
          {children}
        </main>
      </SidebarInset>
    </div>
  </>;
}
