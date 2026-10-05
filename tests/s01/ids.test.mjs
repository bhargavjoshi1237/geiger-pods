import assert from "node:assert/strict";
import test from "node:test";

import { newExtendedRequestId, newPublicId, newRequestId, newShortId } from "../../lib/gateway/ids.mjs";

test("S01: newPublicId returns 10 lowercase alnum chars and 10k ids are unique", () => {
  const id = newPublicId();
  assert.match(id, /^[a-z0-9]{10}$/);
  const seen = new Set([id]);
  for (let i = 1; i < 10000; i++) {
    seen.add(newPublicId());
  }
  assert.equal(seen.size, 10000);
  for (const value of seen) {
    assert.match(value, /^[a-z0-9]{10}$/);
  }
});

test("S01: short, request and extended ids keep their formats", () => {
  assert.match(newShortId(6), /^[a-z0-9]{6}$/);
  assert.match(newShortId(8), /^[a-z0-9]{8}$/);
  assert.match(
    newRequestId(),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.match(newExtendedRequestId(0), /^[a-z2-7]+$/);
  assert.notEqual(newExtendedRequestId(1), newExtendedRequestId(1));
});
