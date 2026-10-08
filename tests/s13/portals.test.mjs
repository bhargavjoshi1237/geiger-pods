import assert from "node:assert/strict";
import test from "node:test";
import { createFakeDb } from "./fake-db.mjs";
import { importNewApi } from "../../lib/control/openapi-import.mjs";
import { sanitizeMarkdown } from "../../lib/gateway/distribution/portals.mjs";
import {
  checkPortalAccess,
  createPortal,
  createPortalProduct,
  createProductPage,
  getPublishedPortal,
  linkProductToPortal,
  listVisibleProducts,
  previewPortal,
  publishPortal,
  setProductSharing,
  updatePortal,
  updatePortalProduct,
} from "../../lib/control/portals.mjs";

const PROJECT_A = "66666666-6666-4666-8666-666666666666";
const PROJECT_B = "77777777-7777-4777-8777-777777777777";
const ADMIN = { type: "user", userId: "u-admin" };
const MEMBER_B = { type: "user", userId: "u-b" };

function rig(roles = { "u-admin": "admin", "u-b": "admin" }) {
  const db = createFakeDb({ roles });
  attachPortalTables(db);
  return db;
}

// In-memory portal tables on top of the S13 fake db (the Supabase mixin in
// lib/control/portal-db.mjs provides the same methods in production).
export function attachPortalTables(db) {
  const portals = new Map();
  const products = new Map();
  const links = new Map();
  const pages = new Map();
  const endpoints = new Map();
  const events = [];
  let seq = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 14, 0, 0, seq++)).toISOString();
  Object.assign(db, {
    _portalMaps: { portals, products, links, pages, endpoints, events },
    async insertPortal(row) {
      const full = { id: `portal-${portals.size + 1}`, created_at: stamp(), updated_at: stamp(), version: 1, ...row };
      portals.set(full.id, full);
      return { ...full };
    },
    async getPortalById({ id }) {
      const row = portals.get(id);
      return row ? { ...row } : null;
    },
    async getPortalBySlug({ slug }) {
      for (const row of portals.values()) if (row.slug === slug) return { ...row };
      return null;
    },
    async listPortals({ projectId }) {
      return [...portals.values()].filter((row) => row.project_id === projectId).map((row) => ({ ...row }));
    },
    async updatePortal({ id, patch }) {
      const row = portals.get(id);
      if (!row) throw new Error("not found");
      const next = { ...row, ...patch, updated_at: stamp(), version: (row.version ?? 1) + 1 };
      portals.set(id, next);
      return { ...next };
    },
    async deletePortal({ id }) {
      portals.delete(id);
      return { id, deleted: true };
    },
    async insertPortalProduct(row) {
      const full = { id: `product-${products.size + 1}`, created_at: stamp(), updated_at: stamp(), version: 1, ...row };
      products.set(full.id, full);
      return { ...full };
    },
    async getPortalProduct({ id }) {
      const row = products.get(id);
      return row ? { ...row } : null;
    },
    async listPortalProducts({ projectId }) {
      return [...products.values()].filter((row) => row.project_id === projectId).map((row) => ({ ...row }));
    },
    async listAllPortalProducts() {
      return [...products.values()].map((row) => ({ ...row }));
    },
    async updatePortalProduct({ id, patch }) {
      const row = products.get(id);
      if (!row) throw new Error("not found");
      const next = { ...row, ...patch, updated_at: stamp(), version: (row.version ?? 1) + 1 };
      products.set(id, next);
      return { ...next };
    },
    async deletePortalProduct({ id }) {
      products.delete(id);
      return { id, deleted: true };
    },
    async linkProduct({ portalId, productId, order = 0 }) {
      const key = `${portalId}:${productId}`;
      const row = { portal_id: portalId, product_id: productId, order, created_at: stamp() };
      links.set(key, row);
      return { ...row };
    },
    async unlinkProduct({ portalId, productId }) {
      links.delete(`${portalId}:${productId}`);
      return { deleted: true };
    },
    async listPortalLinks({ portalId }) {
      return [...links.values()].filter((row) => row.portal_id === portalId).map((row) => ({ ...row }));
    },
    async insertProductPage(row) {
      const full = { id: `page-${pages.size + 1}`, created_at: stamp(), ...row };
      pages.set(full.id, full);
      return { ...full };
    },
    async listProductPages({ productId }) {
      return [...pages.values()].filter((row) => row.product_id === productId).map((row) => ({ ...row }));
    },
    async insertProductEndpoint(row) {
      const full = { id: `ep-${endpoints.size + 1}`, created_at: stamp(), ...row };
      endpoints.set(full.id, full);
      return { ...full };
    },
    async listProductEndpoints({ productId }) {
      return [...endpoints.values()].filter((row) => row.product_id === productId).map((row) => ({ ...row }));
    },
    async insertPortalEvent(row) {
      const full = { created_at: stamp(), ...row };
      events.push(full);
      return { ...full };
    },
  });
  return db;
}

async function seedApi(db, projectId) {
  const created = await importNewApi(db, ADMIN, {
    projectId,
    body: {
      document: {
        swagger: "2.0",
        info: { title: "Portal API", version: "1" },
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              responses: { 200: { description: "ok" } },
              "x-amazon-apigateway-integration": { type: "mock" },
            },
          },
        },
      },
    },
    options: {},
  });
  return created.body.api.id;
}

test("S13D: preview requires workspace auth; published snapshot unaffected by draft edits until republish; disabled portal 404", async () => {
  const db = rig();
  const apiId = await seedApi(db, PROJECT_A);
  const portal = await createPortal(db, ADMIN, {
    projectId: PROJECT_A, name: "Dev portal", slug: "dev-portal-001",
  });
  const product = await createPortalProduct(db, ADMIN, { projectId: PROJECT_A, name: "Pets" });
  await linkProductToPortal(db, ADMIN, { projectId: PROJECT_A, portalId: portal.body.id, productId: product.body.id });
  await createProductPage(db, ADMIN, {
    projectId: PROJECT_A, productId: product.body.id, title: "Guide", slug: "guide", bodyMarkdown: "# Hello",
  });

  // Preview without a workspace actor is rejected.
  await assert.rejects(
    previewPortal(db, null, { projectId: PROJECT_A, slug: portal.body.slug, previewToken: portal.body.previewToken }),
    (error) => error.status === 401,
  );
  const preview = await previewPortal(db, ADMIN, {
    projectId: PROJECT_A, slug: portal.body.slug, previewToken: portal.body.previewToken,
  });
  assert.equal(preview.slug, portal.body.slug);

  // Publish freezes the snapshot; later draft edits do not leak through.
  const published = await publishPortal(db, ADMIN, { projectId: PROJECT_A, portalId: portal.body.id });
  assert.equal(published.body.status, "PUBLISHED");
  await createProductPage(db, ADMIN, {
    projectId: PROJECT_A, productId: product.body.id, title: "Later", slug: "later", bodyMarkdown: "# Later",
  });
  const served = await getPublishedPortal(db, { slug: portal.body.slug });
  assert.ok(!JSON.stringify(served.snapshot).includes("Later"));
  void apiId;

  // Republish picks the edit up.
  await publishPortal(db, ADMIN, { projectId: PROJECT_A, portalId: portal.body.id });
  const republished = await getPublishedPortal(db, { slug: portal.body.slug });
  assert.ok(JSON.stringify(republished.snapshot).includes("Later"));

  // Disable → 404 page.
  await updatePortal(db, ADMIN, { projectId: PROJECT_A, portalId: portal.body.id, patch: { status: "DISABLED" } });
  await assert.rejects(
    getPublishedPortal(db, { slug: portal.body.slug }),
    (error) => error.status === 404,
  );
});

test("S13D: authenticated portal rejects disallowed email domain; markdown sanitizer strips script/iframe/on* attributes", async () => {
  const db = rig();
  const portal = await createPortal(db, ADMIN, {
    projectId: PROJECT_A, name: "Auth portal", slug: "auth-portal-001",
    access: { mode: "authenticated", oidc: { issuer: "https://id.example", clientId: "c", allowedEmailDomains: ["example.com"] } },
  });
  await assert.rejects(
    checkPortalAccess(db, { portalId: portal.body.id, email: "mallory@evil.test", projectId: PROJECT_A }),
    (error) => error.status === 403,
  );
  const allowed = await checkPortalAccess(db, { portalId: portal.body.id, email: "Ada@Example.COM", projectId: PROJECT_A });
  assert.equal(allowed.email, "ada@example.com");

  const dirty = `# Hi\n<script>alert(1)</script>\n<iframe src="https://evil.test"></iframe>\n<img src="x" onerror="alert(1)" onclick="evil()">\n[click](javascript:alert(1))\n<a href="https://ok.test">ok</a>`;
  const clean = sanitizeMarkdown(dirty);
  assert.ok(!/script/i.test(clean), "script stripped");
  assert.ok(!/iframe/i.test(clean), "iframe stripped");
  assert.ok(!/onerror|onclick/i.test(clean), "on* attributes stripped");
  assert.ok(!/javascript:/i.test(clean), "javascript: URLs stripped");
  assert.ok(clean.includes("ok"), "safe content survives");
});

test("S13D: shared product visible to target project, not editable there; revoking sharing removes it from their portals on next publish", async () => {
  const db = rig();
  const shared = await createPortalProduct(db, ADMIN, { projectId: PROJECT_A, name: "Shared pets" });
  // Not visible to B before sharing.
  assert.deepEqual((await listVisibleProducts(db, MEMBER_B, { projectId: PROJECT_B })).map((entry) => entry.id), []);
  await setProductSharing(db, ADMIN, {
    projectId: PROJECT_A, productId: shared.body.id, sharing: { projects: [PROJECT_B], organizations: [] },
  });
  const visible = await listVisibleProducts(db, MEMBER_B, { projectId: PROJECT_B });
  assert.ok(visible.some((entry) => entry.id === shared.body.id));

  // B can link the shared product to their own portal but cannot edit it.
  const bPortal = await createPortal(db, MEMBER_B, { projectId: PROJECT_B, name: "B portal", slug: "b-portal-001" });
  await linkProductToPortal(db, MEMBER_B, { projectId: PROJECT_B, portalId: bPortal.body.id, productId: shared.body.id });
  await assert.rejects(
    updatePortalProduct(db, MEMBER_B, { projectId: PROJECT_B, productId: shared.body.id, patch: { name: "Hijacked" } }),
    (error) => error.status === 403,
  );

  // Revoke sharing: B no longer sees it, and the next publish drops it.
  await setProductSharing(db, ADMIN, {
    projectId: PROJECT_A, productId: shared.body.id, sharing: { projects: [], organizations: [] },
  });
  assert.deepEqual((await listVisibleProducts(db, MEMBER_B, { projectId: PROJECT_B })).map((entry) => entry.id), []);
  const republished = await publishPortal(db, MEMBER_B, { projectId: PROJECT_B, portalId: bPortal.body.id });
  assert.ok(!JSON.stringify(republished.body.publishedSnapshot ?? {}).includes(shared.body.id));
});
