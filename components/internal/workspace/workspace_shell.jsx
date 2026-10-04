"use client";

import { Topbar } from "@geiger/ui/topbar";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, SidebarTrigger, useSidebar } from "@geiger/ui/sidebar";
import { ProfileDropdown } from "@/components/account/profile_dropdown";
import { useRbac } from "@/context/rbac-context";
import { useSession } from "@/context/session-context";
import { useWorkspaceNav, WorkspaceLink } from "@/context/workspace-nav-context";
import { productHref } from "@/lib/workspace/model.mjs";
import { workspaceNav } from "../sidebar/sidebar_nav";

export function WorkspaceShell({ children }) {
  const { memory, projectId, section: active, hrefFor, navigate } = useWorkspaceNav();
  const { can } = useRbac();
  const { user, status } = useSession();
  const { setOpenMobile } = useSidebar();
  const nav = workspaceNav.filter((item) => can(`pods.${item.slug}.view`));
  // The landing playground fakes its session, so it gets no real account menu (or sign-out).
  const profile = memory ? null : user ? <ProfileDropdown user={user} /> : status === "loading" ? <div className="ml-1 size-8 rounded-full border border-border bg-surface-subtle" role="status" aria-label="Checking your Geiger session" /> : null;

  return <>
    <Topbar label="Pods" logoSrc={productHref("/logo1.svg")} homeHref={productHref("/")}
      searchPlaceholder="Search Pods…" searchNav={nav}
      onSearchSelect={(item) => navigate(item.slug)}
      searchRecentsKey="geiger:pods:search-recents"
      profile={profile}
      helpHref={memory ? undefined : projectId ? productHref(hrefFor("roadmap")) : productHref("/")}
    />
    <div className="relative flex flex-1 overflow-hidden">
      <Sidebar collapsible="icon">
        <SidebarContent className="py-1"><SidebarGroup><SidebarGroupContent><SidebarMenu>
          {nav.map((item) => <SidebarMenuItem key={item.slug}>
            <SidebarMenuButton asChild isActive={active === item.slug} tooltip={item.title}>
              <WorkspaceLink section={item.slug} onClick={() => setOpenMobile(false)}><item.icon /><span>{item.title}</span></WorkspaceLink>
            </SidebarMenuButton>
          </SidebarMenuItem>)}
        </SidebarMenu></SidebarGroupContent></SidebarGroup></SidebarContent>
        <SidebarFooter><SidebarTrigger /></SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden border-none bg-transparent">
        <div id="workspace-content" className="relative min-w-0 flex-1 overflow-y-auto p-4 md:p-8">{children}</div>
      </SidebarInset>
    </div>
  </>;
}
