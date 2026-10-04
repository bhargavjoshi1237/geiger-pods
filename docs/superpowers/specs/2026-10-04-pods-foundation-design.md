# Pods foundation design

Date: 4 October 2026. Scope requested: research a Geiger-native AWS API Gateway replacement and implement its foundation through the project overview.

## Outcome

Replace the starter with a public product page and a working shared-project workspace. Use Events as the layout reference and Dash as the identity/project authority. The full gateway is planned in `research/replacement-roadmap.md`; only Phase 0 ships here.

## Architecture

Root theme/session providers serve both the public page and workspace. A single Supabase browser client uses the parent project's settings and cookies. A ProjectProvider loads shared rows and verified org membership, excludes inaccessible projects, and clears data on auth changes. It surfaces errors rather than replacing them with empty lists.

`/project` opens an accessible remembered project or the first available project. `/project/[projectId]/[[...rest]]` renders the registry screen inside the Events-shaped topbar/sidebar/inset shell. Invalid/inaccessible projects have an explanatory state with a return-to-projects action; unknown routes show not-found. Switching project resets the screen to overview.

Session state distinguishes loading, unconfigured, signed-out, error and authenticated. No local auth flow exists. Sign-in links to Dash `/login?next=pods`; project creation links to Dash `/org`. The production base path is `/pods`, matching existing parent rewrites.

## Authorization

Phase 0 is read-only. Inherited role comes from organization_users.role, never user metadata. Organization membership is required for org projects; a creator may access their own organization-less project. The real `@geiger/rbac` package evaluates the Pods view permissions. There is no permissive loading or failure fallback, no gateway mutation endpoint, and no direct shared role/project writes.

Persistent per-product grants and RLS enforcement belong to Phase 1, before configuration mutations. ORM is installed/configured and its commands are available; Phase 0 does not need to create product tables or change the shared schema.

## Screens

- Public landing: shared SuiteHeader/Footer, product explanation, honest foundation status, open workspace CTA, gateway capability groups linked to roadmap.
- Overview: selected project, parent session and access status, project details and next milestone. No invented traffic metrics or deployed APIs.
- Project details (`settings`): read-only shared project name/slug/ID, org and inherited role; parent management link.
- Roadmap: ten gateway phases and feature groups with their status.
- APIs, Deployments, Access, Domains, Monitoring: honest planned screens with phase descriptions and roadmap action. They perform no gateway operations.

## Global constraints

- Next.js 16.2.9; React 19.2.4; Node.js >=22.
- Preserve the existing repository and use package revisions already installed in Events.
- Use `@geiger/ui` components, tokens and animated loading states.
- Match Events' 56px topbar, shared sidebar, scrolling inset and 85% desktop content width.
- Product schema is `pods`; cross-product projects are `public.projects`.
- Keep server credentials out of NEXT_PUBLIC variables and Git.
- No production data mutations or new shared-schema migrations in Phase 0.

## Validation

Test membership filtering, remembered-project fallback, inaccessible IDs, route resolution, cookie/base-path URLs, read-only role mapping and data-layer error propagation. Lint and production build. Browser-check public page, signed-out workspace, responsive menu and shared-session fixture flow. A fixture verifies wiring, not access to a real logged-in parent account. Report that distinction.
