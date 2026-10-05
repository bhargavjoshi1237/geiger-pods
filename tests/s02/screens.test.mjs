import assert from "node:assert/strict";
import test from "node:test";

const screens = await import("../../lib/workspace/screens.mjs");
const model = await import("../../lib/workspace/model.mjs");

test("S02: resolveScreen matches nested patterns and rejects unknown tabs", () => {
  assert.equal(typeof screens.resolveScreen, "function");
  assert.deepEqual(screens.resolveScreen([]), { section: "overview", screen: "overview", params: {} });
  assert.deepEqual(screens.resolveScreen(["apis"]), { section: "apis", screen: "apiList", params: {} });
  assert.deepEqual(
    screens.resolveScreen(["apis", "abc123"]),
    { section: "apis", screen: "apiDetail", params: { apiId: "abc123" } },
  );
  const firstTab = screens.API_DETAIL_TABS[0];
  assert.deepEqual(
    screens.resolveScreen(["apis", "abc123", firstTab]),
    { section: "apis", screen: "apiDetail", params: { apiId: "abc123", tab: firstTab } },
  );
  assert.equal(screens.resolveScreen(["apis", "abc123", "no-such-tab"]), null);
  assert.deepEqual(
    screens.resolveScreen(["secrets"]),
    { section: "secrets", screen: "secretList", params: {} },
  );
  assert.deepEqual(
    screens.resolveScreen(["settings"]),
    { section: "settings", screen: "settings", params: {} },
  );
  assert.deepEqual(
    screens.resolveScreen(["settings", "access"]),
    { section: "settings", screen: "teamAccess", params: {} },
  );
  assert.equal(screens.resolveScreen(["settings", "billing"]), null);
  assert.equal(screens.resolveScreen(["unknown"]), null);
  assert.equal(screens.resolveScreen(["apis", "a", "routes", "extra"]), null);
});

test("S02: resolveSection keeps its single-segment contract", () => {
  assert.equal(typeof model.resolveSection, "function");
  assert.equal(model.resolveSection(), "overview");
  assert.equal(model.resolveSection(["overview"]), "overview");
  assert.equal(model.resolveSection(["settings"]), "settings");
  assert.equal(model.resolveSection(["secrets"]), "secrets");
  assert.equal(model.resolveSection(["unknown"]), null);
  assert.equal(model.resolveSection(["apis", "unimplemented"]), null);
});
