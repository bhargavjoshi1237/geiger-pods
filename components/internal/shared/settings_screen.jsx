"use client";

import { Info, Loader2, LockKeyhole } from "lucide-react";
import { LoadingArea, ScreenHeader } from "@/components/internal/shared/screen_kit";
import { MainScreenWrapper } from "@/components/internal/shared/screen_wrappers";
import { EditorSections } from "@/components/internal/shared/editor_shell";
import { Button } from "@geiger/ui/button";
import { cn } from "@geiger/ui/lib/utils";

// The outer frame of a Settings sub-screen, after geiger-events'
// tickets/settings_kit.jsx: header with a Save action, a read-only notice when
// the viewer can't write, a loading panel, then the event-editor layout —
// section content on the left, section nav on the right.
//
//   <SettingsScreen title="General" sections={SECTIONS} sectionProps={…}
//     loading={…} saving={…} canWrite={…} onSave={save} />
//
// Each section is { key, label, icon, desc, render }; `render` is a component
// that receives `sectionProps`. The screen owns its data — this owns the frame.
export function SettingsScreen({
  title,
  description,
  sections,
  sectionProps,
  defaultSection,
  loading = false,
  loadingLabel = "Loading settings",
  saving = false,
  canWrite = true,
  saveDisabled = false,
  onSave,
  readOnlyNotice,
  children,
}) {
  return <MainScreenWrapper>
    <ScreenHeader
      title={title}
      description={description}
      actions={canWrite && onSave ? <Button
        className="bg-primary text-primary-foreground hover:bg-primary/90"
        disabled={saving || loading || saveDisabled}
        onClick={() => onSave()}
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {saving ? "Saving…" : "Save Changes"}
      </Button> : null}
    />

    {!canWrite && readOnlyNotice ? <Notice icon={LockKeyhole}>{readOnlyNotice}</Notice> : null}

    {loading ? <LoadingArea panel label={loadingLabel} /> : sections?.length ? <EditorSections nav={sections} defaultSection={defaultSection ?? sections[0].key}>
      {({ activeItem }) => {
        // Rendered as an element, not called — sections own their own hooks.
        const Body = activeItem.render;
        return <Body {...sectionProps} />;
      }}
    </EditorSections> : null}

    {loading ? null : children}
  </MainScreenWrapper>;
}

/** The one-line explainer strip settings screens put under the header. */
export function Notice({ icon: Icon = Info, children, className }) {
  return <div className={cn("flex items-start gap-2.5 rounded-lg border border-border bg-surface-card px-3.5 py-2.5 text-xs leading-relaxed text-text-secondary", className)}>
    <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-tertiary" />
    <p>{children}</p>
  </div>;
}

/**
 * Underlined screen tabs, as on geiger-events' Team & Members and Roles &
 * Permissions. `tabs` is [{ key, label, count? }]; a falsy count is hidden.
 */
export function ScreenTabs({ tabs, value, onValueChange }) {
  return <div role="tablist" className="flex items-center gap-1 overflow-x-auto border-b border-border">
    {tabs.map((tab) => {
      const active = tab.key === value;
      return <button
        key={tab.key}
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => onValueChange(tab.key)}
        className={cn(
          "relative shrink-0 px-3 py-2 text-sm font-medium transition-colors",
          active ? "text-foreground" : "text-text-secondary hover:text-foreground",
        )}
      >
        {tab.label}
        {tab.count ? <span className="ml-1.5 text-xs text-text-tertiary">{tab.count}</span> : null}
        {active ? <span className="absolute inset-x-0 -bottom-px h-0.5 bg-primary" /> : null}
      </button>;
    })}
  </div>;
}
