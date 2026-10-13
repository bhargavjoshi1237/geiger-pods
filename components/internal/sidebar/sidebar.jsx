"use client";

import React from "react";
import { PanelLeft } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@geiger/ui/sidebar";
import { Button } from "@geiger/ui/button";
import { Skeleton } from "@geiger/ui/skeleton";
import { cn } from "@geiger/ui/lib/utils";
import { useIdleRecenter } from "@/lib/hooks/use-idle-recenter";
import { SidebarOption } from "./sidebar_option";
import { MobileSidebarHeader } from "./mobile_sidebar_header";

// The workspace sidebar, copied from geiger-events' AppSidebar: grouped nav
// with expandable parents, a skeleton while access resolves, scroll position
// kept across screens, and the collapse toggle in the footer.

const SIDEBAR_SCROLL_ID = "workspace-sidebar-scroll";
let savedSidebarScroll = 0;

const SKELETON_WIDTHS = ["w-24", "w-16", "w-28", "w-20", "w-32", "w-16", "w-24", "w-20"];

function SidebarNavSkeleton() {
  return SKELETON_WIDTHS.map((width, i) => (
    <SidebarMenuItem
      key={i}
      aria-hidden="true"
      className="flex h-9 items-center gap-3 rounded-md px-2 group-data-[collapsible=icon]:justify-center"
    >
      <Skeleton className="h-4 w-4 shrink-0 rounded bg-sidebar-foreground/10" />
      <Skeleton
        className={cn(
          "h-2.5 rounded bg-sidebar-foreground/10 group-data-[collapsible=icon]:hidden",
          width,
        )}
      />
    </SidebarMenuItem>
  ));
}

/**
 * @param {{ nav: Array<object>, activeKey: string|null, loading?: boolean }} props
 *   `activeKey` is the active leaf's `path`.
 */
export function AppSidebar({ nav, activeKey, loading = false }) {
  const { toggleSidebar, state, setOpenMobile } = useSidebar();
  const [expandedItems, setExpandedItems] = React.useState({});
  const { ref: navRef } = useIdleRecenter(activeKey);

  React.useLayoutEffect(() => {
    const el = document.getElementById(SIDEBAR_SCROLL_ID);
    if (el) el.scrollTop = savedSidebarScroll;
  }, []);
  const handleSidebarScroll = (e) => {
    savedSidebarScroll = e.currentTarget.scrollTop;
  };

  const toggleExpand = (title, current) => {
    setExpandedItems((prev) => ({ ...prev, [title]: !current }));
  };
  const closeMobile = () => setOpenMobile(false);

  return (
    <Sidebar
      collapsible="icon"
      className="bg-sidebar border-r border-sidebar-border text-sidebar-foreground"
    >
      <MobileSidebarHeader />
      <SidebarContent
        ref={navRef}
        id={SIDEBAR_SCROLL_ID}
        onScroll={handleSidebarScroll}
        className="py-1 space-y-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {loading && <SidebarNavSkeleton />}
              {!loading && nav.map((item) => {
                const holdsActive = Boolean(item.subItems?.some((sub) => sub.path === activeKey));
                const isExpanded = expandedItems[item.title] !== undefined
                  ? expandedItems[item.title]
                  : holdsActive;
                return (
                  <SidebarOption
                    key={item.title}
                    title={item.title}
                    icon={item.icon}
                    path={item.path}
                    isActive={item.subItems ? holdsActive : activeKey === item.path}
                    subItems={item.subItems || null}
                    isExpanded={isExpanded}
                    onToggle={() => toggleExpand(item.title, isExpanded)}
                    activeKey={activeKey}
                    onNavigate={closeMobile}
                  />
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-2 border-t border-sidebar-border mt-auto">
        <Button
          type="button"
          variant="ghost"
          aria-label={state === "collapsed" ? "Expand sidebar" : "Collapse sidebar"}
          onClick={toggleSidebar}
          className="flex items-center gap-3 p-2 w-full rounded-lg hover:bg-sidebar-accent transition-all text-sidebar-foreground hover:text-foreground group-data-[collapsible=icon]:justify-center"
        >
          <PanelLeft className="w-5 h-5 shrink-0" />
        </Button>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
