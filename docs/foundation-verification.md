# Foundation verification

Verified 4–5 October 2026. Scope: the Geiger public page and read-only project workspace, plus the requested hero artwork revision.

## Automated checks

- `npm test`: 16 passing tests covering project selection, unknown routes, URL prefixes, shared cookies, inherited roles, membership filtering, database failures and inherited-session lifecycle (initial session, cross-port cookie recheck, token refresh, sign-out races, errors and cleanup).
- `npm run lint`: passes.
- `npm run build`: passes on Next.js 16.3.8; `/`, `/project`, not-found and dynamic project screens compile. Production paths use `/pods`.
- `npm audit --omit=dev`: zero vulnerabilities. Five high-severity advisories remain in the development lint dependency chain (`braces` / `micromatch` / `fast-glob` / Next ESLint tooling). The offered forced fix downgrades the Next lint configuration; it was not applied.
- Geiger ORM CLI `--help` succeeds. No product migration has been applied.

Next.js was upgraded from 16.2.9 to the patched 16.3.8 release after dependency auditing, with its matching ESLint configuration. Shared Geiger package revisions match Events.

## Browser checks

The actual production build was served on `http://localhost:3007/pods`. The public page and anonymous workspace rendered, and the sign-in link stayed at the parent `/login?next=pods` route. The revised public hero was also inspected on the normal development preview at `http://localhost:3000/`.

Authenticated checks used `tests/fixtures/suite-server.mjs`, a separate local HTTP server with a fake validated auth user, fake projects and organization membership. The application ran with local fixture Supabase settings and a separate `.next-fixture` output directory. There is no fixture branch or authentication bypass in application code.

Observed:

- `/project` resolves to an accessible project, and remembers the selected project on a later visit.
- Overview displays the selected project and inherited Owner or Member role.
- The initial project switcher changed Alpha to Beta, updated screen links and excluded a returned nonmember project. Following user feedback, this sidebar selector was removed to match Events' rendered workspace. The `/project` resolver still selects an accessible remembered project or the first accessible project.
- Direct navigation to that excluded project shows “Project unavailable” and exposes no workspace screens.
- Project details show the shared project fields and link to parent organization management.
- Shared command search opens the roadmap; future API screens show their planned milestone.
- The initial account menu changed to dark theme during verification. Following user feedback, the custom profile menus were removed from both the public header and project topbar. Theme selection on the public page uses Geiger UI's built-in toggle.
- At a 390 × 844 viewport, the workspace uses the shared mobile sidebar. Selecting a screen closes it. Project details render without horizontal overflow.
- A failed project lookup shows an error and retry action, with no accessible screen navigation.
- Clearing the fixture session and reloading removes project content and displays parent sign-in.
- The revised hero contains the routing hub illustration, one main CTA, and none of the three removed hero labels/sentences. At mobile width, document width equals scroll width. Reduced-motion styling disables packet animation.
- The final landing preview reports no browser console warnings or errors.

The 5 October session fix follows Events' cookie-backed `getSession()` identity handling instead of requiring a separate user lookup. Pods rechecks the session on window focus and tab visibility changes, since auth broadcasts do not span localhost ports. Browser verification with the running fixture confirmed that a session cookie set on port 3010 opens the workspace on port 3008 and clearing it returns to parent sign-in. The regular development preview points sign-in to the running Dash origin on port 3001. No live parent account was signed in in the available browser.

The four decorative plus markers were removed from the hero SVG. The updated landing was visually inspected and saved to ignored `test-results/pods-no-plus.jpg`. Lint and production build pass after these changes.

The subsequent signed-in-header report was reproduced with the fixture: the workspace showed a connected account while the landing header still showed “Sign In.” `SuiteHeader.userId` only controls the mega menu; the account area requires its `profile` slot. Pods now supplies an Events-style avatar dropdown from its session context and holds a placeholder while the session loads. Browser verification confirmed the account menu displays the inherited name/email and parent dashboard/profile links, while clearing the session restores “Sign In.” Screenshot: ignored `test-results/pods-account-menu.jpg`. All 16 tests, lint and the production build pass. This verifies the reported header behavior with an inherited browser session; no live parent login was available to the automation browser.

The final homepage follows the requested reference layout while keeping Pods-specific artwork: a compact intro over a full-width grid, one rounded “Get in your workspace” button, and the routing infographic placed to the right of the hero copy. Events-specific ticket details, perforations and cutouts are absent. The infographic retains no plus markers. At mobile width, the intro and graphic stack cleanly. Desktop and 390px viewport checks report equal document and scroll widths; the workspace CTA points to `/project`. Browser console has no errors. The latest desktop screenshot is saved in ignored `test-results/pods-right-graphic.jpg`. All 16 tests, lint and production build pass after the layout update.

The local screenshot is saved in ignored `test-results/pods-landing.jpg`.

## Shared database inspection

A transaction explicitly set to read-only inspected schema metadata through the existing Events connection, then rolled back. Shared project and membership column names match the query adapter, and RLS is enabled on both tables. No live user or project records were created or modified, and no private database credentials were copied to Pods.

ORM `status` initializes its ledger and can write to the database. It was deliberately not used as a read-only connectivity check. `STRING_URI` is documented for later product migrations.

## Limits of this evidence

The authenticated browser checks validate the actual Supabase client and workspace against an isolated local HTTP fixture. A real Dash browser login, production cookie inheritance through the deployed parent rewrite, and production RLS behavior for multiple real accounts remain deployment acceptance checks. Live account-change races were reviewed in code, rather than exercised with real accounts.

Persistent Pods grants and product-table RLS are required in Phase 1 before configuration mutations. The current inherited role catalog grants read-only views. No API runtime, gateway traffic, API creation, key issuance, deployment publishing or production deployment is claimed by this foundation.
