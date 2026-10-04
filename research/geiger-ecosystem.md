# Geiger ecosystem integration

Inspected local `C:/Pro/geiger-events`, `C:/Pro/geiger-dash`, and the installed shared packages on 4 October 2026.

## Established structure

| Responsibility | Events reference | Pods binding |
|---|---|---|
| Public product page | `app/page.js`, `components/landing/landing_page.jsx` | `/` with shared SuiteHeader, Footer and product introduction |
| Project resolver | `app/project/page.js` | `/project` remembers a still-accessible project, otherwise opens the first |
| Workspace shell | `app/project/[projectId]/workspace_layout.jsx` | Topbar above shared SidebarProvider/SidebarInset; scrolling content |
| Workspace screens | `[[...rest]]/page.js` and screen registry | Explicit route registry; unknown routes render not-found |
| Shared projects | ProjectProvider querying `public.projects` | Read shared IDs/names/org IDs, never manufacture a Pods project ID |
| Session | Supabase SSR browser client | Match Dash URL/key and cookie domain/path/sameSite/secure options |
| Workspace access | `@geiger/rbac`, role catalog and context | Real package decisions; deny while loading and on failure |
| Schema migrations | `@geiger/orm`, `geiger-orm.config.mjs` | `pods` schema; `STRING_URI`; same CLI commands |
| Screen styling | Shared `ScreenHeader`, `SectionCard`, loaders, tokens | Import shared components and tokens directly |

## Parent session and routing

Dash already rewrites `/pods` and `/pods/:path*` to `https://geigerpods.vercel.app/pods...` in `lib/product-routes.mjs`. Production Pods therefore needs `basePath: '/pods'`. Next Link/router add the base path automatically; ordinary anchors and image URLs require explicit prefixing. Local development defaults to no prefix.

Dash's `utils/supabase/client.js` specifies cookie domain from `NEXT_PUBLIC_COOKIE_DOMAIN`, root path `/`, sameSite `lax`, and production secure cookies. Pods uses exactly those options and the same Supabase URL/key. No separate password form, OAuth callback or token handoff is introduced. Supabase's standard storage key remains unchanged.

Same-origin routing through Dash is the normal deployment path. Two localhost ports share hostname-scoped cookies when both use `localhost`; `localhost` and `127.0.0.1` do not share them. Unrelated Vercel hostnames cannot inherit each other's browser cookies. `NEXT_PUBLIC_DASH_URL` optionally points standalone/local navigation back to Dash. Production same-origin login uses `/login?next=pods`, which Dash already accepts.

Session presentation uses the auth listener and cookie-backed `getSession()`, matching Events. Focus and visibility checks pick up parent sign-in/out across local ports. Browser session identity is display state; project queries rely on Supabase RLS and organization membership, never editable metadata for permission decisions. Public HTML contains no user data. See [Supabase SSR clients](https://supabase.com/docs/guides/auth/server-side/creating-a-client), [session cookie guidance](https://supabase.com/docs/guides/auth/server-side/advanced-guide).

## Foundation authorization boundary

The first milestone reads shared projects and verified organization membership. It maps suite Owner/Admin/Manager/member roles to a minimal Pods **read-only** permission catalog through `@geiger/rbac`. For an organization-less project only its authenticated creator is eligible. An org project requires actual membership, even if a permissive legacy projects policy returns its row. Missing membership and failed data queries deny access.

No public role definitions, grants in other products, organizations, or projects are modified by this foundation. Persistent Pods resource grants and database permission predicates are Phase 1 prerequisites before any gateway configuration mutations. The inherited-role model deliberately supplies no API creation, deployment, key issuance, or role-management permissions yet.

## Package revisions

Use the revisions installed in Events: UI `00cac4f5bc540cd910478abb0f240358cc653f08`, RBAC `1835de3735cf9c86df5adebdbc7458dd4302e40d`, ORM `b80e82ce40f10e59742a8e19a8178d1f39a5f817`. Pin Git references and retain the npm lockfile. Configure Tailwind to scan `@geiger/ui/src` and import `@geiger/ui/tokens.css`. Use the shared LogoLoading for section/page loading, icon spinners only for buttons.
