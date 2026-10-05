import assert from "node:assert/strict";
import test from "node:test";

import { supports } from "../../lib/gateway/capabilities.mjs";

test('S01: supports("HTTP","usage.apiKeys") is false and supports("REST","usage.apiKeys") is true', () => {
  assert.equal(supports("HTTP", "usage.apiKeys"), false);
  assert.equal(supports("REST", "usage.apiKeys"), true);
  assert.equal(supports("WEBSOCKET", "usage.apiKeys"), true);
  assert.equal(supports("HTTP", "nope.missing"), false);
  assert.equal(supports("HTTP", "routing.routes"), true);
  assert.equal(supports("REST", "routing.routes"), false);
});
