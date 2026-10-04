# Geiger Pods

The Geiger API gateway product. Phase 0 provides the public page, inherited Geiger session, shared project resolution, native workspace shell, overview, read-only project details and gateway roadmap.

## Run locally

Requires Node.js 22 or later.

```sh
npm install
# Copy .env.example to .env.local and use the same Supabase settings as geiger-dash.
npm run dev -- --port 3007
```

Open `/` for the public page and `/project` for the workspace. Sign in through geiger-dash first. Use the same hostname (`localhost` on both ports) so the browser shares the session cookie. Set `NEXT_PUBLIC_DASH_URL` to the actual Dash origin (for example, `http://localhost:3001` when Pods uses port 3000); leave it empty for same-origin production hosting. Pods reads the inherited browser session like Events and rechecks cookies when the tab regains focus, including sign-in/out on another local port.

## Ecosystem

- `@geiger/ui`: shared tokens, SuiteHeader/Footer, Topbar, Sidebar, screen-kit, dialogs, menus and loaders. Revisions match Events.
- `@geiger/rbac`: minimal read-only permission catalog bound to verified shared org membership. Missing data/errors deny access. Persistent API-scoped grant storage follows in Phase 1.
- `@geiger/orm`: migration tooling configured for the `pods` schema and server-only `STRING_URI`.
- Shared `public.projects` and `public.organization_users` remain owned by the parent suite. Pods does not implement its own login or mutate shared projects.

Production builds default to `/pods`, matching Dash's existing rewrites. `GEIGER_BASE_PATH` overrides this at build time for an isolated deployment. Normal Next links apply the prefix automatically; parent `/login` and `/org` anchors deliberately use the root domain.

## Checks and database workflow

```sh
npm test
npm run lint
npm run build
npm run db:new -- add_api_catalog
npm run db:status
npm run db:push
```

No product migration is needed for the read-only foundation. Before Phase 1 writes, add product tables and audited resource-scoped RLS through Geiger ORM. Never copy a service-role key into a public environment variable.

## Research and plans

- [Research index](research/README.md)
- [AWS capability inventory](research/aws-api-gateway.md)
- [Replacement roadmap](research/replacement-roadmap.md)
- [Geiger integration findings](research/geiger-ecosystem.md)
- [Foundation design](docs/superpowers/specs/2026-10-04-pods-foundation-design.md)
- [Foundation plan](docs/superpowers/plans/2026-10-04-pods-foundation.md)
- [Verification evidence and limits](docs/foundation-verification.md)

APIs, Deployments, Access, Domains and Monitoring currently show their planned milestones. The foundation does not proxy API traffic, create APIs, issue keys or publish deployments. The overview contains no fabricated traffic data.
