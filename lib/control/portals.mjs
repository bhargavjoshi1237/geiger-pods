// Developer portals service (S13 part D).
//
// Portals contain portal products; products group REST API endpoints and
// documentation. Preview renders the current draft (workspace auth +
// preview token); publish freezes a snapshot (products, pages, endpoint
// pages with resolved docs, branding) into `published_snapshot`. The public
// portal only reads snapshots; DISABLED → 404. Authenticated portals run an
// OIDC code+PKCE session with an allowed-email-domain filter (the session
// itself is verified by the app layer; here we enforce the domain filter).
// Shared products are readable by target projects/orgs but not editable
// there; revoking sharing drops them from the next publish.
//
// Also registers the `portals` stack kind (follow-up F25) via
// `registerStackHandler`, so declarative stacks manage portals without
// editing `lib/control/stacks.mjs`.
//
// @module lib/control/portals

import { randomUUID } from "node:crypto";
import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { resolveApi } from "./apis.mjs";
import { registerStackHandler } from "./stacks.mjs";
import { buildPortalSnapshot } from "../gateway/distribution/portals.mjs";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const STATUSES = ["DRAFT", "PUBLISHED", "DISABLED"];

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkSlug(slug) {
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.slug: must match ^[a-z0-9][a-z0-9-]{1,63}$");
  }
  return slug;
}

function checkName(name, field = "$.name") {
  if (typeof name !== "string" || name.length < 1 || name.length > 128) {
    throw new HttpError(422, "invalid_input", `Invalid request: ${field}: must be a string of 1–128 characters`);
  }
  return name;
}

function cleanBranding(input) {
  if (input === undefined) return undefined;
  if (!isObject(input)) throw new HttpError(422, "invalid_input", "Invalid request: $.branding: expected an object");
  const out = {};
  for (const key of ["logoAssetId", "faviconAssetId", "primaryColor", "accentColor", "theme", "headerLinks", "footerMarkdown"]) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  if (out.theme !== undefined && !["light", "dark", "system"].includes(out.theme)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.branding.theme: must be one of light, dark, system");
  }
  if (out.footerMarkdown !== undefined && typeof out.footerMarkdown !== "string") {
    throw new HttpError(422, "invalid_input", "Invalid request: $.branding.footerMarkdown: expected a string");
  }
  return out;
}

function cleanAccess(input) {
  if (input === undefined) return undefined;
  if (!isObject(input)) throw new HttpError(422, "invalid_input", "Invalid request: $.access: expected an object");
  const mode = input.mode ?? "public";
  if (mode !== "public" && mode !== "authenticated") {
    throw new HttpError(422, "invalid_input", "Invalid request: $.access.mode: must be one of public, authenticated");
  }
  const out = { mode };
  if (input.oidc !== undefined) {
    if (!isObject(input.oidc)) throw new HttpError(422, "invalid_input", "Invalid request: $.access.oidc: expected an object");
    const domains = input.oidc.allowedEmailDomains ?? [];
    if (!Array.isArray(domains)) throw new HttpError(422, "invalid_input", "Invalid request: $.access.oidc.allowedEmailDomains: expected an array");
    out.oidc = {
      ...(typeof input.oidc.issuer === "string" ? { issuer: input.oidc.issuer.slice(0, 512) } : {}),
      ...(typeof input.oidc.clientId === "string" ? { clientId: input.oidc.clientId.slice(0, 256) } : {}),
      ...(Array.isArray(input.oidc.scopes) ? { scopes: input.oidc.scopes.filter((entry) => typeof entry === "string").slice(0, 16) } : {}),
      allowedEmailDomains: domains.filter((entry) => typeof entry === "string").map((entry) => entry.toLowerCase().slice(0, 253)).slice(0, 64),
    };
  }
  return out;
}

function cleanSharing(input) {
  if (input === undefined || input === null) return { projects: [], organizations: [] };
  if (!isObject(input)) throw new HttpError(422, "invalid_input", "Invalid request: $.sharing: expected an object");
  const projects = Array.isArray(input.projects) ? input.projects.filter((entry) => typeof entry === "string").slice(0, 100) : [];
  const organizations = Array.isArray(input.organizations) ? input.organizations.filter((entry) => typeof entry === "string").slice(0, 100) : [];
  return { projects, organizations };
}

function toPortalView(row) {
  return {
    id: row.id, projectId: row.project_id, name: row.name, slug: row.slug,
    domainId: row.domain_id ?? null, branding: row.branding ?? {}, access: row.access ?? { mode: "public" },
    analyticsEnabled: row.analytics_enabled ?? false, status: row.status ?? "DRAFT",
    publishedAt: row.published_at ?? null, previewToken: row.preview_token ?? null,
    version: row.version ?? 1, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function toProductView(row) {
  return {
    id: row.id, projectId: row.project_id, name: row.name,
    description: row.description ?? "", displayOrder: row.display_order ?? 0,
    usagePlanId: row.usage_plan_id ?? null, sharing: row.sharing ?? { projects: [], organizations: [] },
    version: row.version ?? 1, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

async function scopedPortal(db, projectId, portalId) {
  const row = typeof db.getPortalById === "function" ? await db.getPortalById({ id: portalId }) : null;
  if (!row || row.project_id !== projectId) throw new HttpError(404, "not_found", "Portal does not exist.");
  return row;
}

async function scopedProduct(db, projectId, productId) {
  const row = typeof db.getPortalProduct === "function" ? await db.getPortalProduct({ id: productId }) : null;
  if (!row) throw new HttpError(404, "not_found", "Product does not exist.");
  return row;
}

function productVisibleTo(row, projectId) {
  if (row.project_id === projectId) return true;
  const sharing = row.sharing ?? { projects: [], organizations: [] };
  return (sharing.projects ?? []).includes(projectId);
}

/** Create a portal (slug globally unique). */
export async function createPortal(db, actor, { projectId, name, slug, branding, access, domainId = null, analyticsEnabled = false, requestId = null }) {
  await requirePermission(db, actor, "pods.portal.write", { projectId });
  const cleanSlug = checkSlug(slug);
  if (typeof db.getPortalBySlug === "function" && await db.getPortalBySlug({ slug: cleanSlug })) {
    throw new HttpError(409, "conflict", `A portal with slug "${cleanSlug}" already exists.`);
  }
  const row = await db.insertPortal({
    id: randomUUID(), project_id: projectId, name: checkName(name),
    slug: cleanSlug, domain_id: domainId, branding: cleanBranding(branding) ?? {},
    access: cleanAccess(access) ?? { mode: "public" },
    analytics_enabled: analyticsEnabled === true, status: "DRAFT",
    published_snapshot: null, published_at: null, preview_token: randomUUID().replace(/-/g, "").slice(0, 32),
    created_by: actor?.userId ?? null,
  });
  await audit(db, actor, {
    action: "portal.create", resourceType: "portal", resourceId: row.id,
    projectId, before: null, after: toPortalView(row), requestId,
  });
  return { status: 201, body: { ...toPortalView(row), previewToken: row.preview_token } };
}

/** Update a portal (branding, access, status, name). */
export async function updatePortal(db, actor, { projectId, portalId, patch, expectedVersion = null, requestId = null }) {
  await requirePermission(db, actor, "pods.portal.write", { projectId });
  const current = await scopedPortal(db, projectId, portalId);
  if (expectedVersion !== null && current.version !== expectedVersion) {
    throw new HttpError(409, "version_conflict", `Portal changed (expected version ${expectedVersion}, found ${current.version}).`);
  }
  const next = {};
  if (patch.name !== undefined) next.name = checkName(patch.name);
  if (patch.branding !== undefined) next.branding = cleanBranding(patch.branding) ?? {};
  if (patch.access !== undefined) next.access = cleanAccess(patch.access) ?? { mode: "public" };
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status)) throw new HttpError(422, "invalid_input", "Invalid request: $.status: must be one of DRAFT, PUBLISHED, DISABLED");
    if (patch.status === "PUBLISHED") {
      throw new HttpError(422, "invalid_input", "Publish via POST …/publish so a snapshot is frozen.");
    }
    next.status = patch.status;
  }
  if (patch.analyticsEnabled !== undefined) next.analytics_enabled = patch.analyticsEnabled === true;
  const row = await db.updatePortal({ id: current.id, patch: { ...next, version: (current.version ?? 1) + 1 } });
  await audit(db, actor, {
    action: "portal.update", resourceType: "portal", resourceId: current.id,
    projectId, before: toPortalView(current), after: toPortalView(row), requestId,
  });
  return toPortalView(row);
}

/** Preview the current draft (workspace auth + preview token required). */
export async function previewPortal(db, actor, { projectId, slug, previewToken }) {
  if (!actor) throw new HttpError(401, "unauthenticated", "Sign in to preview this portal.");
  await requirePermission(db, actor, "pods.apis.view", { projectId });
  const row = typeof db.getPortalBySlug === "function" ? await db.getPortalBySlug({ slug }) : null;
  if (!row || row.project_id !== projectId) throw new HttpError(404, "not_found", "Portal does not exist.");
  if (!previewToken || row.preview_token !== previewToken) {
    throw new HttpError(403, "forbidden", "A valid preview token is required.");
  }
  return { ...toPortalView(row), draft: true };
}

/** Publish: freeze products, pages, endpoints and branding into the snapshot. */
export async function publishPortal(db, actor, { projectId, portalId, requestId = null }) {
  await requirePermission(db, actor, "pods.portal.publish", { projectId });
  const current = await scopedPortal(db, projectId, portalId);
  const links = typeof db.listPortalLinks === "function" ? await db.listPortalLinks({ portalId: current.id }) : [];
  const products = [];
  const pagesByProduct = new Map();
  const endpointsByProduct = new Map();
  for (const link of links) {
    const product = typeof db.getPortalProduct === "function" ? await db.getPortalProduct({ id: link.product_id }) : null;
    // Revoked sharing drops the product from the next publish.
    if (!product || !productVisibleTo(product, projectId)) continue;
    products.push(product);
    pagesByProduct.set(product.id, typeof db.listProductPages === "function" ? await db.listProductPages({ productId: product.id }) : []);
    endpointsByProduct.set(product.id, typeof db.listProductEndpoints === "function" ? await db.listProductEndpoints({ productId: product.id }) : []);
  }
  products.sort((left, right) => (left.display_order ?? 0) - (right.display_order ?? 0));
  const snapshot = buildPortalSnapshot({ portal: current, products, pagesByProduct, endpointsByProduct });
  const row = await db.updatePortal({
    id: current.id,
    patch: { published_snapshot: snapshot, published_at: new Date().toISOString(), status: "PUBLISHED", version: (current.version ?? 1) + 1 },
  });
  await audit(db, actor, {
    action: "portal.publish", resourceType: "portal", resourceId: current.id,
    projectId, before: { status: current.status }, after: { status: "PUBLISHED", products: products.length }, requestId,
  });
  return { status: 200, body: { ...toPortalView(row), publishedSnapshot: snapshot } };
}

/** Serve the published snapshot (public; DISABLED → 404). */
export async function getPublishedPortal(db, { slug }) {
  const row = typeof db.getPortalBySlug === "function" ? await db.getPortalBySlug({ slug }) : null;
  if (!row || row.status === "DISABLED" || !row.published_snapshot) {
    throw new HttpError(404, "not_found", "Portal does not exist.");
  }
  return { ...toPortalView(row), snapshot: row.published_snapshot };
}

/**
 * Resolve the published snapshot for a public visitor (S13 fix-up).
 *
 * The public portal pages must call this (never the draft tables) before
 * rendering anything. For `access.mode === "authenticated"` the viewer must
 * be a signed-in end user whose email passes `checkPortalAccess`; anonymous
 * visitors get 401 and disallowed domains get 403. Denials carry no snapshot
 * content, so pages can render them verbatim.
 *
 * @param {object} db - Needs `getPortalBySlug` (+ `getPortalById` via
 *   `checkPortalAccess` for authenticated portals).
 * @param {{ slug: string, email?: string|null }} input
 */
export async function resolvePublishedPortalView(db, { slug, email = null }) {
  if (typeof slug !== "string" || slug === "" || slug.length > 256) {
    throw new HttpError(404, "not_found", "Portal does not exist.");
  }
  const row = typeof db.getPortalBySlug === "function" ? await db.getPortalBySlug({ slug }) : null;
  if (!row || row.status === "DISABLED" || !row.published_snapshot) {
    throw new HttpError(404, "not_found", "Portal does not exist.");
  }
  const access = row.access ?? { mode: "public" };
  if (access.mode === "authenticated") {
    if (!email) {
      throw new HttpError(401, "unauthenticated", "Sign in to view this portal.");
    }
    await checkPortalAccess(db, { portalId: row.id, email });
  }
  return {
    slug: row.slug, status: row.status, access,
    snapshot: row.published_snapshot,
  };
}

/**
 * Resolve one product from the published snapshot's visible products.
 *
 * Only products frozen into the snapshot at publish time render; anything
 * else (including live draft products never published) is 404. Authentication
 * is enforced exactly as in `resolvePublishedPortalView`.
 *
 * @param {object} db - Same port as `resolvePublishedPortalView`.
 * @param {{ slug: string, productId: string, email?: string|null }} input
 */
export async function resolvePublishedPortalProductView(db, { slug, productId, email = null }) {
  const view = await resolvePublishedPortalView(db, { slug, email });
  const products = view.snapshot?.products ?? [];
  const product = products.find((entry) => entry && entry.id === productId) ?? null;
  if (!product) {
    throw new HttpError(404, "not_found", "Product does not exist.");
  }
  return { ...view, product };
}

/** Enforces the allowed-email-domain filter for authenticated portals. */
export async function checkPortalAccess(db, { portalId, email, projectId = null }) {
  const lookup = typeof db.getPortalById === "function" ? await db.getPortalById({ id: portalId }) : null;
  if (!lookup) throw new HttpError(404, "not_found", "Portal does not exist.");
  const access = lookup.access ?? { mode: "public" };
  if (access.mode !== "authenticated") return { email: String(email ?? "").toLowerCase(), portalId };
  const raw = String(email ?? "").trim().toLowerCase().slice(0, 320);
  const at = raw.lastIndexOf("@");
  if (at === -1) throw new HttpError(403, "forbidden", "A valid email is required for this portal.");
  const domain = raw.slice(at + 1);
  const allowed = (access.oidc?.allowedEmailDomains ?? []).map((entry) => String(entry).toLowerCase());
  if (allowed.length > 0 && !allowed.includes(domain)) {
    throw new HttpError(403, "forbidden", `Email domain "${domain}" is not allowed on this portal.`);
  }
  return { email: raw, portalId };
}

/** Create a portal product. */
export async function createPortalProduct(db, actor, { projectId, name, description = "", displayOrder = 0, usagePlanId = null, sharing = null, requestId = null }) {
  await requirePermission(db, actor, "pods.portal.write", { projectId });
  const row = await db.insertPortalProduct({
    id: randomUUID(), project_id: projectId, name: checkName(name),
    description: typeof description === "string" ? description.slice(0, 2048) : "",
    display_order: Number.isInteger(displayOrder) ? displayOrder : 0,
    usage_plan_id: usagePlanId, sharing: cleanSharing(sharing),
    created_by: actor?.userId ?? null,
  });
  await audit(db, actor, {
    action: "portal_product.create", resourceType: "portal_product", resourceId: row.id,
    projectId, before: null, after: toProductView(row), requestId,
  });
  return { status: 201, body: toProductView(row) };
}

/** Update a product (owner project only; shared copies are read-only). */
export async function updatePortalProduct(db, actor, { projectId, productId, patch, requestId = null }) {
  const current = await scopedProduct(db, projectId, productId);
  if (current.project_id !== projectId) throw new HttpError(403, "forbidden", "Shared products cannot be edited here.");
  await requirePermission(db, actor, "pods.portal.write", { projectId });
  const next = {};
  if (patch.name !== undefined) next.name = checkName(patch.name);
  if (patch.description !== undefined) next.description = String(patch.description ?? "").slice(0, 2048);
  if (patch.displayOrder !== undefined) next.display_order = Number(patch.displayOrder) || 0;
  if (patch.usagePlanId !== undefined) next.usage_plan_id = patch.usagePlanId;
  const row = await db.updatePortalProduct({ id: current.id, patch: { ...next, version: (current.version ?? 1) + 1 } });
  await audit(db, actor, {
    action: "portal_product.update", resourceType: "portal_product", resourceId: current.id,
    projectId, before: toProductView(current), after: toProductView(row), requestId,
  });
  return toProductView(row);
}

/** Change cross-project sharing (owner only). */
export async function setProductSharing(db, actor, { projectId, productId, sharing, requestId = null }) {
  const current = await scopedProduct(db, projectId, productId);
  if (current.project_id !== projectId) throw new HttpError(403, "forbidden", "Only the owning project can share this product.");
  await requirePermission(db, actor, "pods.portal.write", { projectId });
  const row = await db.updatePortalProduct({
    id: current.id, patch: { sharing: cleanSharing(sharing), version: (current.version ?? 1) + 1 },
  });
  await audit(db, actor, {
    action: "portal_product.share", resourceType: "portal_product", resourceId: current.id,
    projectId, before: { sharing: current.sharing }, after: { sharing: row.sharing }, requestId,
  });
  return toProductView(row);
}

/** Products visible to a project: owned plus shared-in. */
export async function listVisibleProducts(db, actor, { projectId }) {
  await requirePermission(db, actor, "pods.apis.view", { projectId });
  const owned = typeof db.listPortalProducts === "function" ? await db.listPortalProducts({ projectId }) : [];
  const all = typeof db.listAllPortalProducts === "function"
    ? await db.listAllPortalProducts()
    : owned;
  const seen = new Map();
  for (const row of [...owned, ...all]) {
    if (!productVisibleTo(row, projectId)) continue;
    if (!seen.has(row.id)) seen.set(row.id, toProductView(row));
  }
  return [...seen.values()].sort((left, right) => left.displayOrder - right.displayOrder);
}

/** Link a visible product to a portal in the same project. */
export async function linkProductToPortal(db, actor, { projectId, portalId, productId, order = 0 }) {
  await requirePermission(db, actor, "pods.portal.write", { projectId });
  const portal = await scopedPortal(db, projectId, portalId);
  const product = await scopedProduct(db, productId, productId).catch(() => null)
    ?? (typeof db.getPortalProduct === "function" ? await db.getPortalProduct({ id: productId }) : null);
  if (!product || !productVisibleTo(product, projectId)) {
    throw new HttpError(404, "not_found", "Product does not exist.");
  }
  return db.linkProduct({ portalId: portal.id, productId: product.id, order: Number.isInteger(order) ? order : 0 });
}

/** Add a markdown product page. */
export async function createProductPage(db, actor, { projectId, productId, title, slug, bodyMarkdown = "", order = 0, requestId = null }) {
  const product = await scopedProduct(db, projectId, productId);
  if (product.project_id !== projectId) throw new HttpError(403, "forbidden", "Shared products cannot be edited here.");
  await requirePermission(db, actor, "pods.portal.write", { projectId });
  if (typeof title !== "string" || title === "" || title.length > 256) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.title: must be a string of 1–256 characters");
  }
  if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{1,127}$/.test(slug)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.slug: must match ^[a-z0-9][a-z0-9-]{1,127}$");
  }
  if (typeof bodyMarkdown !== "string" || Buffer.byteLength(bodyMarkdown, "utf8") > 256 * 1024) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.bodyMarkdown: must be a string of at most 256 KB");
  }
  // Prototype-pollution guard on the slug key.
  if (["__proto__", "constructor", "prototype"].includes(slug)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.slug: reserved name");
  }
  const row = await db.insertProductPage({
    id: randomUUID(), project_id: projectId, product_id: product.id,
    title, slug, body_markdown: bodyMarkdown, order: Number.isInteger(order) ? order : 0,
    created_by: actor?.userId ?? null,
  });
  await audit(db, actor, {
    action: "portal_page.create", resourceType: "portal_page", resourceId: row.id,
    projectId, before: null, after: { id: row.id, slug }, requestId,
  });
  return { status: 201, body: row };
}

/** Add an endpoint page pointing at a deployed stage operation. */
export async function createProductEndpoint(db, actor, { projectId, productId, apiId, stageName, resourcePath, httpMethod, operationName = "", displayOverrideMarkdown = null, tryItEnabled = true, requestId = null }) {
  const product = await scopedProduct(db, projectId, productId);
  if (product.project_id !== projectId) throw new HttpError(403, "forbidden", "Shared products cannot be edited here.");
  await requirePermission(db, actor, "pods.portal.write", { projectId });
  const api = await resolveApi(db, projectId, apiId);
  if (api.protocol !== "REST") {
    throw new HttpError(400, "capability_unsupported", "Portal endpoint pages are only available on REST APIs.");
  }
  if (typeof stageName !== "string" || stageName === "" || stageName.length > 128) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.stageName: must be a string of 1–128 characters");
  }
  if (typeof resourcePath !== "string" || !resourcePath.startsWith("/") || resourcePath.length > 1024) {
    throw new HttpError(422, "invalid_input", 'Invalid request: $.resourcePath: must start with "/"');
  }
  const method = String(httpMethod ?? "").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ANY"].includes(method)) {
    throw new HttpError(422, "invalid_input", "Invalid request: $.httpMethod: must be an HTTP method");
  }
  const row = await db.insertProductEndpoint({
    id: randomUUID(), project_id: projectId, product_id: product.id,
    api_id: api.id, stage_name: stageName, resource_path: resourcePath, http_method: method,
    operation_name: typeof operationName === "string" ? operationName.slice(0, 256) : "",
    display_override_markdown: displayOverrideMarkdown,
    try_it_enabled: tryItEnabled !== false,
    created_by: actor?.userId ?? null,
  });
  await audit(db, actor, {
    action: "portal_endpoint.create", resourceType: "portal_endpoint", resourceId: row.id,
    projectId, apiId: api.id, before: null, after: { id: row.id, method, resourcePath }, requestId,
  });
  return { status: 201, body: row };
}

/** Record a portal analytics event (page view / try-it). */
export async function recordPortalEvent(db, { portalId, type, productId = null }) {
  if (!["page_view", "try_it"].includes(type)) throw new HttpError(422, "invalid_input", "Invalid portal event type.");
  if (typeof db.insertPortalEvent !== "function") return null;
  return db.insertPortalEvent({ portal_id: portalId, product_id: productId, type });
}

// --- `portals` stack kind (F25) -------------------------------------------------
// Declarative shape: `{ portals: [{ name, slug, status?, branding?, access? }] }`.
// Plan diffs name/branding/access; apply creates/updates via the services.
// Prune-gated deletes mirror the `api` kind.

registerStackHandler("portals", {
  async plan(db, { projectId, desired, live, prune }) {
    const ops = [];
    const liveByName = new Map((live ?? []).map((row) => [row.name, row]));
    const wanted = new Set();
    for (const entry of desired ?? []) {
      if (!entry || typeof entry.name !== "string" || entry.name === "") {
        throw new HttpError(422, "invalid_input", "Each portals[] entry requires a name.");
      }
      wanted.add(entry.name);
      const current = liveByName.get(entry.name);
      if (!current) {
        ops.push({ name: entry.name, op: "create", identity: { name: entry.name }, diff: { after: entry } });
        continue;
      }
      const diff = {};
      for (const field of ["branding", "access", "status"]) {
        if (JSON.stringify(current[field] ?? null) !== JSON.stringify(entry[field] ?? current[field] ?? null)) {
          diff[field] = { before: current[field] ?? null, after: entry[field] ?? null };
        }
      }
      ops.push({
        name: entry.name, op: Object.keys(diff).length === 0 ? "noop" : "update",
        identity: { name: entry.name, id: current.id }, diff,
      });
    }
    for (const row of live ?? []) {
      if (!wanted.has(row.name)) {
        ops.push({
          name: row.name, op: "delete", identity: { name: row.name, id: row.id },
          diff: { before: row }, ...(prune ? {} : { skipped: "needs_prune" }),
        });
      }
    }
    return ops;
  },
  async apply(db, actor, { projectId, change }) {
    if (change.op === "create") {
      const after = change.diff?.after ?? {};
      const created = await db.stackCreatePortal?.({ project_id: projectId, name: change.name, file: after })
        ?? await createPortal(db, actor, {
          projectId, name: change.name, slug: after.slug ?? change.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 64),
          branding: after.branding, access: after.access,
        });
      await db.tagStackResource?.({ project_id: projectId, stack: change.stack, resource_type: "portal", resource_id: created?.body?.id ?? created?.id ?? change.name }).catch(() => null);
      return { applied: true };
    }
    if (change.op === "update") {
      const after = change.diff?.after ?? change.diff ?? {};
      if (typeof db.stackUpdatePortal === "function") {
        await db.stackUpdatePortal({ project_id: projectId, id: change.identity?.id, name: change.name, file: after });
      } else {
        await updatePortal(db, actor, {
          projectId, portalId: change.identity?.id,
          patch: { ...(after.branding ? { branding: after.branding } : {}), ...(after.access ? { access: after.access } : {}) },
        });
      }
      return { applied: true };
    }
    if (change.op === "delete") {
      if (typeof db.stackDeletePortal === "function") {
        await db.stackDeletePortal({ project_id: projectId, id: change.identity?.id, name: change.name });
      } else if (typeof db.deletePortal === "function") {
        await db.deletePortal({ id: change.identity?.id });
      }
      return { applied: true };
    }
    return { applied: false };
  },
});
