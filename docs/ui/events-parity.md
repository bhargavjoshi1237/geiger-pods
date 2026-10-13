# Geiger Pods ← Geiger Events UI parity guide

Pods (C:\Pro\geiger-pods) and Events (C:\Pro\geiger-events) are products in the same suite. Users who know Events
must find the same layouts, the same controls in the same places, and the same behaviours in Pods. Events is the
reference; copy its patterns, do not invent new ones. Both use the same `@geiger/ui` revision.

Pods is Next 16 / React 19, plain JS (.jsx).

## Import paths (Pods)

| Thing | Import from |
|---|---|
| ScreenHeader, StatsBar, StatGrid, StatTile, Toolbar, SearchInput, DataTable, EmptyState, StatusPill, SectionCard, SettingsList, SettingRow, Field, InlineTitleInput, SegmentedTabs, EditorSectionHeader, LoadingArea | `@/components/internal/shared/screen_kit` (port of Events' screen_kit — use it, not `@geiger/ui/screen-kit`) |
| MainScreenWrapper, SecondaryScreenWrapper | `@/components/internal/shared/screen_wrappers` |
| ListPagination, usePagination | `@/components/internal/shared/pagination` |
| EditorShell, EditorSections, EditorHeader | `@/components/internal/shared/editor_shell` |
| FilterDropdown (default export) | `@/components/internal/screens/overview/filter_dropdown` — props `{ value, onValueChange, options:[{value,label}], height="h-9", label (aria) }` |
| ActionMenu | `@geiger/ui/action-menu` — `items=[{icon,label,onSelect},{separator:true},{icon:Trash2,label:"Delete",variant:"destructive",onSelect}]`, `label="Actions for X"` |
| Button, Badge, Input, Textarea, Label, Select*, Dialog*, Switch, Checkbox… | `@geiger/ui/<name>` |
| cn | `@geiger/ui/lib/utils` |
| toast | `sonner` |
| open-record-in-URL hook | `useRecordParam` from `@/lib/hooks/use-record-param` → `const [recordId, setRecordId] = useRecordParam()` (`?record=` param; pushState; back/forward work; playground-safe) |
| project / rbac / nav | `useProject()` (`project.id`), `useRbac()` (`can("pods.x.write")`), `useWorkspaceNav()` (`navigate("path")`, `hrefFor`) |

## Screen archetypes (copy exactly)

### 1. List screen — reference: Events `components/internal/screens/events/all_events.jsx` and `tickets/records_kit.jsx` (RecordsScreen); in Pods `components/internal/screens/apis/api_list.jsx` is already converted — read it first.

```
<MainScreenWrapper>
  <ScreenHeader title="Usage Plans" description="One sentence on what this is / why."
    actions={<Button className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={openCreate}><Plus className="h-4 w-4" /> New Usage Plan</Button>} />
  <StatsBar stats={[{label, value: String(n), footer}, …]} />      // optional; 2–4 real numbers derived from loaded data. Never fabricate.
  <Toolbar>
    <div className="flex items-center gap-2">{FilterDropdown(s) with "All …" first option, height="h-9"}</div>
    <SearchInput value={search} onChange={setSearch} placeholder="Search usage plans…" />
  </Toolbar>
  {loading ? <LoadingArea panel /> : error ? <bordered EmptyState w/ Retry> : (
    <div className="space-y-5">
      <DataTable columns={columns} data={pager.pageItems} getRowKey={(r) => r.id} onRowClick={(r) => open(r)}
        empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={…} title={items.length ? "No usage plans match your filters" : "No usage plans yet"} description=… action={<Primary + New …>} /></div>} />
      <ListPagination {...pager} itemLabel="usage plans" />
    </div>)}
  <Create Dialog/> <Delete confirm Dialog/>
</MainScreenWrapper>
```
- `const pager = usePagination(filtered, { resetKey: \`${search}|${filterA}\` })`.
- Columns: identity first (name in `font-medium text-foreground`, secondary line `text-xs text-text-secondary`; records may lead with the 36px icon tile `flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-card text-muted-foreground`), then type (`<Badge variant="neutral">` / `"outline"`), details/summary (`text-sm text-text-secondary`), status (`<StatusPill status map={STATUS_MAP}>`), numbers right-aligned `tabular-nums`, and LAST an `actions` column `{ key:"actions", header:"", align:"right", className:"text-right", render: r => <ActionMenu …/> }`.
- Row actions go in the ActionMenu (Edit/Open, Duplicate, Rotate, Disable…, separator, Delete destructive). No rows of inline outline buttons.
- Row click opens the record (edit page) — see 3.
- Hide write actions (create button, mutating menu items) when `!can(...)` instead of showing a disabled pile; read-only users still see the list.

### 2. Create dialog — reference: `CreateEventDialog` in all_events.jsx
```
<Dialog open onOpenChange><DialogContent className="max-w-xl bg-background">   // sm:max-w-md for small forms
  <DialogHeader><DialogTitle>Create Usage Plan</DialogTitle><DialogDescription>Set the essentials now — …</DialogDescription></DialogHeader>
  <div className="grid gap-4"> <Field label="Name" htmlFor="x"><Input id="x" autoFocus …/></Field>  … two-up rows: <div className="grid grid-cols-2 gap-4">…</div> </div>
  <DialogFooter>
    <Button variant="outline" className="border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground" onClick={close}>Cancel</Button>
    <Button className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={submit} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Create Usage Plan</Button>
  </DialogFooter>
</DialogContent></Dialog>
```
- Use `Field` (label + control, optional `hint`) instead of hand-rolled `<div className="space-y-2"><Label/>…`.
- Validation errors: `toast.error("Give your plan a name first.")`. Success: `toast.success(\`"${name}" created.\`)`. Server failures: `toast.error(error.message)`.
- Title Case for dialog titles and primary buttons ("Create Usage Plan", "Save Changes"); sentence case for descriptions.

### 3. Record edit page (row click) — reference: Events records_kit `RecordEditPage` / `event_detail.jsx`; Pods `apis/api_detail.jsx`
- Opened IN PLACE by the list screen (list screen returns the edit page instead of the list while a record is open), with `useRecordParam()` so the URL carries `?record=<id>` and Back closes it. Never a modal for "view/edit details" of a record that has more than a couple of fields.
- Simple record (one form): `<SecondaryScreenWrapper><EditorHeader back={{label:"All Usage Plans", onClick:()=>setRecordId(null)}} title={name} status statusMap meta actions={<Save Changes primary>}/><div className="mt-6 space-y-6">…SectionCards…</div></SecondaryScreenWrapper>`.
- Record with several areas (settings + keys + stages + usage, etc.): `<EditorShell back title status statusMap badges meta actions nav={[{group:null|"Group", items:[{key,label,icon,desc}]}]} active onActiveChange>{({active}) => body}</EditorShell>` — right-hand section nav, section header (label + desc) rendered automatically. Use the second `useRecordParam("section")` for the active section if you want it in the URL, otherwise local state.
- Header actions: primary "Save Changes" at the far right; secondary icon/outline buttons before it. Destructive actions live in a "Danger zone" SectionCard at the bottom of a settings section, or the list's ActionMenu — not in the header.

### 4. Delete / destructive confirmation — reference: bottom of all_events.jsx
```
<Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}><DialogContent className="sm:max-w-md">
  <DialogHeader><DialogTitle>Delete usage plan</DialogTitle><DialogDescription>Are you sure you want to delete <span className="font-medium text-foreground">{deleteTarget?.name}</span>? This action can&apos;t be undone.</DialogDescription></DialogHeader>
  <DialogFooter><Button variant="ghost" onClick={() => setDeleteTarget(null)}>Cancel</Button>
  <Button className="bg-red-500/90 text-white hover:bg-red-500" onClick={…}><Trash2 className="h-4 w-4" /> Delete</Button></DialogFooter>
</DialogContent></Dialog>
```
Every delete/revoke/disable-that-breaks-traffic goes through this. No `window.confirm`, no unconfirmed deletes.

### 5. Settings screen — reference: Events `tickets/settings_kit.jsx` (SettingsScreen) and `settings/notifications.jsx`
```
<MainScreenWrapper>
  <ScreenHeader title description actions={<Button primary disabled={saving||loading}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{saving ? "Saving…" : "Save Changes"}</Button>} />
  {loading ? <LoadingArea panel /> : <EditorSections nav={sections} defaultSection=…>{({activeItem}) => <activeItem.render …/>}</EditorSections>}
</MainScreenWrapper>
```
- Toggles: `<SettingsList><SettingRow icon title description checked onCheckedChange /></SettingsList>`; other controls via `SettingRow control={…}`.
- Form groups: `<SectionCard title description action={…}>` (prop is `action`, singular — `actions` is silently dropped).
- Single-section settings can skip EditorSections and render SectionCards in `<div className="space-y-6">`.

### 6. Loading / empty / error states
- Whole route still resolving: bare centered `LoadingArea` (no card). Inside a screen whose header is already visible: `<LoadingArea panel />` (bordered box) — never a lone spinner box on an otherwise empty page, never "Loading…" text.
- Inline/button spinners: lucide `Loader2 className="h-4 w-4 animate-spin"`.
- Empty/error inside a screen: `<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon title description action /></div>` (SectionCard-wrapped EmptyState is also acceptable inside editor sections).
- Errors offer a Retry (`variant="outline"`) that refetches, not `window.location.reload()` where a refetch exists.

### 7. Detail/secondary info
- Read-only key/value facts: a `SectionCard` with a `dl` grid (`grid gap-4 sm:grid-cols-2`, `dt text-xs text-text-secondary`, `dd text-sm text-foreground`), or SettingsList rows.
- Monospace identifiers (`font-mono text-xs`) with a copy button (lucide `Copy`, ghost icon-sm button, `toast.success("Copied.")`).
- Secrets/keys shown once: a Dialog after creation with the value in a mono read-only Input + Copy, and a warning line.

### 8. Navigation & placement
- The sidebar (components/internal/sidebar/sidebar_nav.jsx) is now grouped like Events: Overview · APIs · Usage (Usage Plans, API Keys) · Security (Secrets, Web Application Firewall, Signing Credentials) · Networking (Custom Domains, Trust Stores, Connectors) · Monitoring (Dashboard, Logs, Alarms, Log Exports) · Portals · Settings (General, Team & Access, Access Tokens, Stacks, Audit Log).
- Workspace paths: overview, apis, usage-plans, api-keys, secrets, waf, access/credentials, domains, domains/truststores, connectors, monitoring, monitoring/logs, monitoring/alarms, monitoring/exports, portals, settings, settings/access, settings/tokens, settings/stacks, audit.
- REMOVE the old rows of cross-link buttons (`<Button variant="outline" size="sm" asChild><a href="truststores">Trust stores</a></Button>` etc.) from ScreenHeader actions — the sidebar now holds those destinations, Events has no such link rows. A contextual link inside body copy is fine; use `WorkspaceLink section="path"` from `@/context/workspace-nav-context` (or `navigate("path")`), never relative `<a href="../x">`.
- Screen titles = the sidebar leaf title (e.g. "Usage Plans", "API Keys", "Web Application Firewall", "Trust Stores", "Log Exports", "Team & Access", "Audit Log"). Title Case.

### 9. Copy & tone (Events)
- Header descriptions: one or two plain sentences, user-facing, no spec numbers (no "S10 §3", "F29", "phase 6"), no implementation jargon unless it's the product concept.
- Buttons: "New X" / "Create X" for primary create (Events uses both: list header "Create Event", records "New {singular}"; pick "New X" for Pods records and keep it consistent within a screen), "Save Changes", "Cancel", "Delete".
- Toasts: short past-tense sentences ("Saved.", `Deleted "${name}".`).

## Rules when changing a screen
- Keep behaviour: every API call, permission check, field and feature survives a restyle.
- Hide write controls the actor can't use (`can(...)`) instead of showing disabled piles.
- No new dependencies for UI work; extend the shared kit (screen_kit, editor_shell, pagination) only by porting the Events version.
