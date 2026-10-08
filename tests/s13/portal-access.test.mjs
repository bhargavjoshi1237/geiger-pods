import assert from "node:assert/strict";
import test from "node:test";
import { createFakeDb } from "./fake-db.mjs";
import { attachPortalTables } from "./portals.test.mjs";
import {
  createPortal,
  createPortalProduct,
  createProductPage,
  linkProductToPortal,
  publishPortal,
  resolvePublishedPortalProductView,
  resolvePublishedPortalView,
} from "../../lib/control/portals.mjs";

const PROJECT = "99999999-9999-4999-8999-999999999999";
const ADMIN = { type: "user", userId: "u-admin" };

function rig() {
  return attachPortalTables(createFakeDb({ roles: { "u-admin": "admin" } }));
}

async function seedPublished(db, { slug, access = undefined, productName = "Pets" }) {
  const portal = await createPortal(db, ADMIN, {
    projectId: PROJECT, name: `Portal ${slug}`, slug, access,
  });
  const product = await createPortalProduct(db, ADMIN, { projectId: PROJECT, name: productName });
  await linkProductToPortal(db, ADMIN, {
    projectId: PROJECT, portalId: portal.body.id, productId: product.body.id,
  });
  await createProductPage(db, ADMIN, {
    projectId: PROJECT, productId: product.body.id,
    title: "Guide", slug: "guide", bodyMarkdown: "# Secret Guide Body",
  });
  await publishPortal(db, ADMIN, { projectId: PROJECT, portalId: portal.body.id });
  return { portal: portal.body, product: product.body };
}

const AUTH_ACCESS = {
  mode: "authenticated",
  oidc: { issuer: "https://id.example", clientId: "c", allowedEmailDomains: ["example.com"] },
};

test("S13D: authenticated portal + anonymous visitor → no snapshot content", async () => {
  const db = rig();
  const { portal } = await seedPublished(db, { slug: "auth-anon-portal-001", access: AUTH_ACCESS });
  const error = await resolvePublishedPortalView(db, { slug: portal.slug, email: null }).then(
    () => null,
    (failure) => failure,
  );
  assert.ok(error, "anonymous visitor is denied");
  assert.equal(error.status, 401);
  const leaked = JSON.stringify([error.message, error.details ?? null]);
  assert.ok(!leaked.includes("Secret Guide Body"), "denial carries no snapshot content");
  assert.ok(!leaked.includes("Pets"), "denial carries no snapshot content");
});

test("S13D: authenticated portal rejects disallowed email domain", async () => {
  const db = rig();
  const { portal } = await seedPublished(db, { slug: "auth-denied-portal-001", access: AUTH_ACCESS });
  const error = await resolvePublishedPortalView(db, {
    slug: portal.slug, email: "mallory@evil.test",
  }).then(
    () => null,
    (failure) => failure,
  );
  assert.ok(error, "disallowed domain is denied");
  assert.equal(error.status, 403);
  const leaked = JSON.stringify([error.message, error.details ?? null]);
  assert.ok(!leaked.includes("Secret Guide Body"), "denial carries no snapshot content");
});

test("S13D: authenticated portal allows listed email domain", async () => {
  const db = rig();
  const { portal } = await seedPublished(db, { slug: "auth-ok-portal-001", access: AUTH_ACCESS });
  const view = await resolvePublishedPortalView(db, { slug: portal.slug, email: "Ada@Example.COM" });
  assert.ok(JSON.stringify(view.snapshot).includes("Secret Guide Body"), "allowed domain sees the snapshot");
  assert.equal(view.snapshot.products.length, 1);
});

test("S13D: public portal renders snapshot for anonymous visitors", async () => {
  const db = rig();
  const { portal } = await seedPublished(db, { slug: "public-portal-001" });
  const view = await resolvePublishedPortalView(db, { slug: portal.slug, email: null });
  assert.ok(JSON.stringify(view.snapshot).includes("Secret Guide Body"), "public snapshot is served");
});

test("S13D: product pages outside the published snapshot 404; auth still enforced", async () => {
  const db = rig();
  const { portal, product } = await seedPublished(db, { slug: "auth-product-portal-001", access: AUTH_ACCESS });

  // A product id that is not in the published snapshot → 404 (no content).
  await assert.rejects(
    resolvePublishedPortalProductView(db, { slug: portal.slug, productId: "product-not-published", email: "ada@example.com" }),
    (error) => error.status === 404,
  );

  // Anonymous visitor on the real product → 401 with no snapshot content.
  const anonError = await resolvePublishedPortalProductView(
    db, { slug: portal.slug, productId: product.id, email: null },
  ).then(
    () => null,
    (failure) => failure,
  );
  assert.ok(anonError, "anonymous visitor is denied the product page");
  assert.equal(anonError.status, 401);
  assert.ok(
    !JSON.stringify([anonError.message, anonError.details ?? null]).includes("Secret Guide Body"),
    "denial carries no snapshot content",
  );

  // Allowed domain sees the snapshot product.
  const view = await resolvePublishedPortalProductView(
    db, { slug: portal.slug, productId: product.id, email: "ada@example.com" },
  );
  assert.equal(view.product.id, product.id);
  assert.ok(JSON.stringify(view.product).includes("Secret Guide Body"));

  // Public portal product renders for anonymous visitors.
  const pub = await seedPublished(db, { slug: "public-product-portal-001" });
  const pubView = await resolvePublishedPortalProductView(
    db, { slug: pub.portal.slug, productId: pub.product.id, email: null },
  );
  assert.equal(pubView.product.id, pub.product.id);
});
