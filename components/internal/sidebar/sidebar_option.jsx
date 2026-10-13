"use client";

import React from "react";
import { ChevronDown } from "lucide-react";
import {
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@geiger/ui/sidebar";
import { Button } from "@geiger/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@geiger/ui/tooltip";
import { cn } from "@geiger/ui/lib/utils";
import { WorkspaceLink } from "@/context/workspace-nav-context";

// One sidebar entry, as in geiger-events: a leaf links straight to its screen;
// a parent with subItems only expands, and its leaves list underneath (icons
// with tooltips when the sidebar is collapsed to its rail).
export function SidebarOption({
  title,
  icon: Icon,
  path,
  isActive,
  subItems,
  isExpanded,
  onToggle,
  activeKey,
  onNavigate,
}) {
  const { state, isMobile } = useSidebar();
  const isCollapsed = state === "collapsed" && !isMobile;

  const buttonClass = cn(
    "transition-all text-sm h-9 group-data-[collapsible=icon]:justify-center",
    isActive && !subItems
      ? "bg-sidebar-accent text-foreground"
      : isExpanded
        ? "bg-sidebar-accent/40 text-sidebar-foreground"
        : "text-sidebar-foreground",
  );
  const iconNode = Icon ? (
    <Icon
      className={cn(
        "w-4 h-4 shrink-0 transition-colors",
        isActive ? "text-foreground" : "text-sidebar-foreground/70",
      )}
    />
  ) : null;

  const subActive = (sub) => activeKey === sub.path;
  const subClass = (sub) =>
    cn(
      "relative w-full flex items-center px-2 h-[35px] rounded-md text-sm leading-none transition-colors",
      subActive(sub)
        ? "bg-sidebar-accent text-foreground font-medium"
        : "text-sidebar-foreground/70 hover:text-foreground hover:bg-sidebar-accent/50",
    );
  const subIcon = (sub) =>
    sub.icon ? (
      <sub.icon
        className={cn(
          "w-4 h-4 shrink-0 transition-colors",
          subActive(sub) ? "text-foreground" : "text-sidebar-foreground/70",
        )}
      />
    ) : null;

  return (
    <SidebarMenuItem>
      {subItems ? (
        <SidebarMenuButton
          type="button"
          onClick={onToggle}
          isActive={isActive}
          tooltip={title}
          aria-expanded={Boolean(isExpanded)}
          className={buttonClass}
        >
          {iconNode}
          {!isCollapsed && <span>{title}</span>}
          {!isCollapsed && (
            <ChevronDown
              className={cn(
                "ml-auto w-4 h-4 transition-transform duration-200",
                isExpanded && "rotate-180",
              )}
            />
          )}
        </SidebarMenuButton>
      ) : (
        <SidebarMenuButton asChild isActive={isActive} tooltip={title} className={buttonClass}>
          <WorkspaceLink section={path} onClick={onNavigate} data-active={isActive ? "true" : undefined}>
            {iconNode}
            {!isCollapsed && <span>{title}</span>}
          </WorkspaceLink>
        </SidebarMenuButton>
      )}

      {subItems && isExpanded && !isCollapsed && (
        <ul className="ml-[1px] mt-1 mb-1 flex flex-col gap-0.5 pl-2">
          {subItems.map((sub) => (
            <li key={sub.path}>
              <Button asChild variant="ghost" className={cn(subClass(sub), "justify-start gap-2")}>
                <WorkspaceLink
                  section={sub.path}
                  onClick={onNavigate}
                  data-active={subActive(sub) ? "true" : undefined}
                  aria-current={subActive(sub) ? "page" : undefined}
                >
                  {subIcon(sub)}
                  <p>{sub.title}</p>
                </WorkspaceLink>
              </Button>
            </li>
          ))}
        </ul>
      )}

      {subItems && isExpanded && isCollapsed && (
        <ul className="flex flex-col gap-0.5 pt-2">
          {subItems.map((sub) => (
            <li key={sub.path}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button asChild variant="ghost" className={cn(subClass(sub), "justify-center")}>
                    <WorkspaceLink
                      section={sub.path}
                      onClick={onNavigate}
                      aria-label={sub.title}
                      data-active={subActive(sub) ? "true" : undefined}
                      aria-current={subActive(sub) ? "page" : undefined}
                    >
                      {subIcon(sub)}
                    </WorkspaceLink>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right" align="center">
                  {sub.title}
                </TooltipContent>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
    </SidebarMenuItem>
  );
}
