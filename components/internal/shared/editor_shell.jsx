"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";

import { MainScreenWrapper } from "@/components/internal/shared/screen_wrappers";
import { EditorSectionHeader, StatusPill } from "@geiger/ui/screen-kit";
import { ExpandableSearch } from "@geiger/ui/expandable-search";
import { cn } from "@geiger/ui/lib/utils";
import { useIdleRecenter } from "@/lib/hooks/use-idle-recenter";

// Nav search only earns its space once the list is long enough to scan.
const SEARCH_THRESHOLD = 8;

// Back link + title + status + meta + actions. Every editor screen's header.
export function EditorHeader({
  back,
  title,
  status,
  statusMap,
  badges,
  meta,
  actions,
  className,
}) {
  return (
    <div className={cn("border-b border-border pb-6", className)}>
      {back ? (
        <button
          type="button"
          onClick={back.onClick}
          className="mb-2 inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {back.label}
        </button>
      ) : null}
      {/* Actions align to the title row, not the whole block — a header without
          meta must not float them up between the back link and the title. */}
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          {title || status ? (
            <div className="flex min-h-9 flex-wrap items-center gap-2.5">
              {typeof title === "string" ? (
                <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
                  {title}
                </h1>
              ) : (
                title
              )}
              {status && statusMap ? (
                <StatusPill status={status} map={statusMap} />
              ) : null}
            </div>
          ) : null}
          {badges ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {badges}
            </div>
          ) : null}
          {meta ? (
            typeof meta === "string" ? (
              <p className="mt-1 text-sm font-medium text-muted-foreground">
                {meta}
              </p>
            ) : (
              <div className="mt-1 text-sm font-medium text-muted-foreground">
                {meta}
              </div>
            )
          ) : null}
        </div>
        {actions ? (
          <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function NavItem({ item, active, onSelect }) {
  const Icon = item.icon;
  const isActive = active === item.key;
  return (
    <button
      type="button"
      data-active={isActive ? "true" : undefined}
      onClick={() => onSelect(item.key)}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors",
        isActive
          ? "bg-surface-card font-medium text-foreground dark:text-white"
          : "text-muted-foreground hover:bg-surface-subtle hover:text-foreground",
      )}
    >
      {Icon ? (
        <Icon
          className={cn(
            "h-4 w-4 shrink-0",
            isActive ? "text-foreground dark:text-white" : "text-text-secondary",
          )}
        />
      ) : null}
      <span className="truncate capitalize">{item.label}</span>
    </button>
  );
}

// Library collapse animation runs 200ms (transition-[width] duration-200);
// the post-reset glide starts once the field is closed.
const SEARCH_COLLAPSE_MS = 220;

// The section nav that sits to the right of the editor body.
function EditorNav({
  groups,
  active,
  onSelect,
  query,
  onQueryChange,
  search,
  searchOpen,
  onSearchOpenChange,
  navRef,
  fullHeight,
}) {
  return (
    <aside
      className={cn(
        "order-1 lg:order-2",
        fullHeight && "lg:flex lg:min-h-0 lg:flex-col",
      )}
    >
      {search ? (
        <div className="mb-3 lg:shrink-0">
          <ExpandableSearch
            value={query}
            onChange={onQueryChange}
            placeholder="Search screens…"
            label="Search screens"
            open={searchOpen}
            onOpenChange={onSearchOpenChange}
            expandedWidth="16rem"
            className="ml-auto"
            inputClassName="[&::-webkit-search-cancel-button]:appearance-none"
          />
        </div>
      ) : null}
      <nav
        ref={navRef}
        className={cn(
          "space-y-5 lg:overflow-y-auto lg:pr-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          fullHeight
            ? "lg:min-h-0 lg:flex-1"
            : "lg:sticky lg:top-0 lg:max-h-[calc(100dvh-7.5rem)]",
        )}
      >
        {/*
          Collapse consecutive ungrouped (`group: null`) groups into a single
          block so they sit at the same rhythm as the items inside a grouped
          section instead of getting the parent nav's space-y-5 (20px) between
          each one. The five extracted sections that follow Tickets are the
          reason this exists — without this they read as five orphaned entries
          with big gaps, not as a continuation of the right-hand list.
        */}
        {(() => {
          const runs = [];
          for (const group of groups) {
            const last = runs[runs.length - 1];
            if (last && !last.group.group && !group.group) {
              last.groups.push(group);
            } else {
              runs.push({ group: group, groups: [group] });
            }
          }
          return runs.map((run, ri) => {
            if (run.groups.length === 1) {
              const group = run.group;
              return (
                <div key={group.group || `g${ri}`}>
                  {group.group ? (
                    <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                      {group.group}
                    </p>
                  ) : null}
                  <div className="space-y-0.5">
                    {group.items.map((item) => (
                      <NavItem
                        key={item.key}
                        item={item}
                        active={active}
                        onSelect={onSelect}
                      />
                    ))}
                  </div>
                </div>
              );
            }
            return (
              <div key={`g${ri}`} className="space-y-0.5">
                {run.groups.flatMap((g) =>
                  g.items.map((item) => (
                    <NavItem
                      key={item.key}
                      item={item}
                      active={active}
                      onSelect={onSelect}
                    />
                  )),
                )}
              </div>
            );
          });
        })()}
        {groups.length === 0 ? (
          <p className="px-3 text-sm text-text-tertiary">
            No screens match “{query}”.
          </p>
        ) : null}
      </nav>
    </aside>
  );
}

// Accepts either flat items or [{ group, items }] and always yields groups.
function toGroups(nav) {
  if (!nav?.length) return [];
  return nav[0]?.items ? nav : [{ group: null, items: nav }];
}

const normalize = (s) => s?.toLowerCase().replace(/[-_]/g, " ") || "";

/**
 * The editor body: scrollable content on the left, section nav on the right.
 * Use this directly only when the screen owns its own header (a project-global
 * settings screen, say); otherwise reach for EditorShell.
 *
 * Pass `active` + `onActiveChange` to drive the section from the route (the
 * API editor keeps it in the path); otherwise the section is local state.
 */
export function EditorSections({
  nav,
  sections,
  sectionProps,
  subject,
  navContext,
  sectionAction,
  searchable,
  fullHeight = false,
  defaultSection,
  active: activeProp,
  onActiveChange,
  children,
  className,
}) {
  const groups = useMemo(() => toGroups(nav), [nav]);
  const firstKey = groups[0]?.items?.[0]?.key;
  const fallback = defaultSection || firstKey;

  const [localSection, setLocalSection] = useState(fallback);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const clearTimer = useRef(null);
  const glideTimer = useRef(null);

  useEffect(
    () => () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
      if (glideTimer.current) clearTimeout(glideTimer.current);
    },
    [],
  );

  const cancelPendingReset = () => {
    if (clearTimer.current) {
      clearTimeout(clearTimer.current);
      clearTimer.current = null;
    }
    if (glideTimer.current) {
      clearTimeout(glideTimer.current);
      glideTimer.current = null;
    }
  };

  const handleQueryChange = (value) => {
    // User is actively searching — never auto-clear under them.
    cancelPendingReset();
    setQuery(value);
  };

  const controlled = activeProp !== undefined;
  const rawActive = controlled ? activeProp : localSection;

  const known = useMemo(
    () => new Set(groups.flatMap((g) => g.items.map((i) => i.key))),
    [groups],
  );
  const active = known.has(rawActive) ? rawActive : fallback;
  const { ref: navRef, recenter } = useIdleRecenter(active);

  const setActive = (key) => {
    // A selection from filtered results keeps the filter visible for 15s so
    // the result context stays on screen, then closes the field (animated)
    // and glides the selected screen back to center. A plain nav click (no
    // active filter) never touches the search.
    const hadFilter = normalize(query).trim().length > 0;
    onActiveChange?.(key);
    if (hadFilter) {
      cancelPendingReset();
      clearTimer.current = setTimeout(() => {
        clearTimer.current = null;
        setQuery("");
        setSearchOpen(false);
        glideTimer.current = setTimeout(() => {
          glideTimer.current = null;
          recenter();
        }, SEARCH_COLLAPSE_MS);
      }, 15000);
    }
    if (!controlled) setLocalSection(key);
  };

  const activeItem = useMemo(
    () =>
      groups.flatMap((g) => g.items).find((i) => i.key === active) ||
      groups[0]?.items?.[0],
    [groups, active],
  );

  const q = normalize(query).trim();
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (i) => !i.showIf || i.showIf(subject ?? sectionProps, navContext),
      ),
    }))
    .map((group) => ({
      ...group,
      items: q
        ? group.items.filter(
            (item) =>
              normalize(item.label).includes(q) ||
              normalize(group.group).includes(q),
          )
        : group.items,
    }))
    .filter((group) => group.items.length > 0);

  const itemCount = groups.reduce((n, g) => n + g.items.length, 0);
  const showSearch = searchable ?? itemCount >= SEARCH_THRESHOLD;

  const ActiveSection = sections?.[active];

  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-8 lg:grid-cols-[1fr_260px]",
        fullHeight && "lg:min-h-0 lg:flex-1 lg:grid-rows-1",
        className,
      )}
    >
      <div
        className={cn(
          "order-2 min-w-0 lg:order-1",
          fullHeight && "scrollbar-subtle lg:min-h-0 lg:overflow-y-auto lg:pr-2",
        )}
      >
        {activeItem && !activeItem.ownHeader ? (
          <EditorSectionHeader
            title={activeItem.label}
            description={activeItem.desc}
            action={sectionAction}
            className="mb-5"
          />
        ) : null}
        {typeof children === "function" ? (
          children({ active, activeItem })
        ) : ActiveSection ? (
          <ActiveSection {...sectionProps} headerItem={activeItem} />
        ) : (
          children
        )}
      </div>

      <EditorNav
        groups={visibleGroups}
        active={active}
        onSelect={setActive}
        query={query}
        onQueryChange={handleQueryChange}
        search={showSearch}
        searchOpen={searchOpen}
        onSearchOpenChange={setSearchOpen}
        navRef={navRef}
        fullHeight={fullHeight}
      />
    </div>
  );
}

/**
 * The editor screen: header on top, EditorSections below. This is the layout
 * every editor in the app shares — the event edit page is the reference, so its
 * frame (pinned header, nav and body scrolling in place) is the default here.
 * Pass fullHeight={false} for an editor that should scroll with the page.
 */
export function EditorShell({
  back,
  title,
  status,
  statusMap,
  badges,
  meta,
  actions,
  beforeBody,
  after,
  fullHeight = true,
  className,
  ...sectionsProps
}) {
  return (
    <MainScreenWrapper
      className={cn(
        fullHeight &&
          "lg:flex lg:h-full lg:flex-col lg:gap-6 lg:space-y-0 lg:overflow-hidden lg:py-0",
        className,
      )}
    >
      <EditorHeader
        back={back}
        title={title}
        status={status}
        statusMap={statusMap}
        badges={badges}
        meta={meta}
        actions={actions}
        className={fullHeight ? "lg:shrink-0" : undefined}
      />

      {beforeBody ? (
        <div className={fullHeight ? "lg:shrink-0" : undefined}>{beforeBody}</div>
      ) : null}

      <EditorSections fullHeight={fullHeight} {...sectionsProps} />

      {after}
    </MainScreenWrapper>
  );
}

export default EditorShell;
