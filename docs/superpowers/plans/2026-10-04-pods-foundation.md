# Pods Foundation Implementation Plan

> For agentic workers: use superpowers:executing-plans to implement the tasks in this session. The user explicitly requested setup as well as planning.

**Goal:** Build the Geiger-native public page and inherited-session workspace through project overview.

**Architecture:** Reuse shared Geiger UI and Events' shell. Bind one Supabase client to Dash cookies, shared projects and organization membership. Read-only views use the real Geiger RBAC evaluator.

**Tech Stack:** Next.js 16.3.8, React 19.2.4, Tailwind 4, @geiger/ui, @geiger/rbac, @geiger/orm, Supabase SSR.

**Spec:** `docs/superpowers/specs/2026-10-04-pods-foundation-design.md`.

## Global constraints

Use Node.js >=22. Pin Geiger package commits from Events. Use `pods` for product schema. Production basePath `/pods`; same-origin parent routes remain root-relative. No gateway mutation or shared-schema modification in Phase 0. Keep private env values untracked.

## Review focus

- Remembered project was removed or access revoked: pick only from verified current projects.
- Supabase/session/member lookup fails: show error and deny instead of inventing projects or permissions.
- User signs out or account changes: clear projects and inherited permissions before reloading.
- Production prefixed routes: local links get one `/pods` prefix; parent login/org routes get none.
- Nonmember receives a project through permissive legacy RLS: membership filter still denies it.

## Task 1: shared dependencies and navigation contracts

Files: `package.json`, lockfile, `next.config.mjs`, `geiger-orm.config.mjs`, `.env.example`, `lib/workspace/model.mjs`, `tests/workspace.test.mjs`.

- [x] Add pinned packages and ORM CLI scripts. Use the patched Next 16.3.8 release and matching lint configuration.
- [x] Write failing tests for remembered-project fallback, route sections, cookie options and local/parent URLs.
- [x] Implement `pickDefaultProjectId(projects, remembered)`, `resolveSection(rest)`, `productHref(path, basePath)` and `dashHref(path, origin)`.
- [x] Run `npm test` and ORM CLI `--help`. Verify database metadata in an explicit read-only transaction; ORM status may initialize its ledger.

```js
assert.equal(pickDefaultProjectId([{ id: 'current' }], 'revoked'), 'current');
assert.equal(productHref('/project', '/pods'), '/pods/project');
assert.equal(dashHref('/login?next=pods', ''), '/login?next=pods');
assert.equal(resolveSection(['unknown']), null);
```

## Task 2: inherited session and authorized projects

Files: `lib/supabase/client.js`, `lib/supabase/projects.js`, `lib/workspace/access.mjs`, `geiger-rbac.config.js`, `context/session-context.jsx`, `context/project-context.jsx`, `context/rbac-context.jsx`, `tests/access.test.mjs`, `tests/projects.test.mjs`.

- [x] Test real read-only RBAC decisions and filtering against trusted org membership inputs.
- [x] Implement pure project access functions; deny missing membership, metadata-based elevation, loading and failed reads.
- [x] Implement `listAccessibleProjects(client, userId)` returning normalized projects; throw on query errors.
- [x] Implement session subscription plus validated `getUser()`; prevent stale auth requests from winning after sign-out.
- [x] Key project state to user identity, cancel stale responses and expose `refresh()` for retry.
- [x] Run the complete unit suite.

```js
assert.equal(inheritedRole({ organizationId: 'org', createdBy: 'u' }, [], 'u'), null);
assert.equal(inheritedRole({ organizationId: null, createdBy: 'u' }, [], 'u'), 'owner');
assert.equal(can('pods.api.create', { config, roles, grants, actorId: 'u' }), false);
```

## Task 3: Geiger shell and project screens

Files: root providers/CSS, `components/internal/{workspace,sidebar,topbar,screens}`, project routes, screen registry.

- [x] Import shared tokens/animations and set Tailwind package source.
- [x] Build the Events-shaped workspace using shared Topbar, SidebarProvider, SidebarInset and screen-kit. Reuse the Geiger logo.
- [x] Wire project selection, accessible screen search, theme/account menu and parent links.
- [x] Implement overview, read-only project details and roadmap; mark future operation screens as planned.
- [x] Add route loading, error and not-found states with shared components.
- [x] Verify no unavailable screen can expose an action and unknown routes do not silently become overview.

```jsx
<SidebarProvider className="flex-col !flex h-full min-w-0">
  <Topbar />
  <div className="flex flex-1 overflow-hidden">
    <AppSidebar />
    <SidebarInset><main>{children}</main></SidebarInset>
  </div>
</SidebarProvider>
```

## Task 4: public entry and research deliverables

Files: `app/page.js`, `components/landing`, `components/header.jsx`, research Markdown and README.

- [x] Build a public product page using SuiteHeader, Footer, Button and Card with Geiger tokens.
- [x] Explain the gateway product and current foundation milestone accurately. Link workspace and roadmap.
- [x] Save primary-source AWS feature map, ecosystem findings and phased replacement roadmap.
- [x] Document local/parent cookie sharing, production routing and database workflow.

## Task 5: verification

- [x] Run `npm test` and `npm run lint`.
- [x] Run `npm run build`; verify `/pods` production paths and static route shell.
- [x] Run local server and inspect public page, anonymous workspace, mobile shell, inherited-session project selection, overview, theme and project switching using an isolated session fixture where needed.
- [x] Verify actual shared schema/connection read-only when configured; do not create unrelated data.
- [x] Record evidence and limitations in `docs/foundation-verification.md` and report to the user.

Full gateway implementation proceeds via [the replacement roadmap](../../../research/replacement-roadmap.md); it is not part of this foundation plan.
