import assert from "node:assert/strict";
import test from "node:test";

const model = await import("../lib/workspace/model.mjs").catch(() => ({}));

test("project selection ignores a revoked remembered project", () => {
  assert.equal(typeof model.pickDefaultProjectId, "function");
  assert.equal(model.pickDefaultProjectId([{ id: "a" }, { id: "b" }], "b"), "b");
  assert.equal(model.pickDefaultProjectId([{ id: "a" }], "revoked"), "a");
  assert.equal(model.pickDefaultProjectId([], "revoked"), null);
});

test("unknown or nested screen URLs cannot silently become overview", () => {
  assert.equal(typeof model.resolveSection, "function");
  assert.equal(model.resolveSection(), "overview");
  assert.equal(model.resolveSection(["overview"]), "overview");
  assert.equal(model.resolveSection(["settings"]), "settings");
  assert.equal(model.resolveSection(["unknown"]), null);
  assert.equal(model.resolveSection(["apis", "unimplemented"]), null);
});

test("product URLs get one base path and parent URLs stay at the root", () => {
  assert.equal(typeof model.productHref, "function");
  assert.equal(model.productHref("/project", "/pods"), "/pods/project");
  assert.equal(model.productHref("/", "/pods"), "/pods");
  assert.equal(model.productHref("/project", ""), "/project");
  assert.equal(model.dashHref("/login?next=pods", ""), "/login?next=pods");
  assert.equal(model.dashHref("/org", "http://localhost:3000/"), "http://localhost:3000/org");
});

test("cookie options agree with the parent app in development and production", () => {
  assert.equal(typeof model.suiteCookieOptions, "function");
  assert.deepEqual(model.suiteCookieOptions(".geiger.studio", true), {
    domain: ".geiger.studio", path: "/", sameSite: "lax", secure: true,
  });
  assert.deepEqual(model.suiteCookieOptions("", false), {
    domain: undefined, path: "/", sameSite: "lax", secure: false,
  });
});
