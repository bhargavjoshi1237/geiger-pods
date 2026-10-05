import assert from "node:assert/strict";
import test from "node:test";

import { v, validate } from "../../lib/control/validate.mjs";
import { HttpError } from "../../lib/control/errors.mjs";

function invalid(schema, input) {
  assert.throws(() => validate(schema, input), (error) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 422);
    assert.equal(error.code, "invalid_input");
    return true;
  });
}

test("S02: validate accepts well-formed input and rejects unknown fields", () => {
  const schema = v.object({
    name: v.string({ min: 1, max: 64 }),
    retries: v.optional(v.int({ min: 0, max: 5 })),
    mode: v.enum(["open", "closed"]),
    tags: v.optional(v.array(v.string({ max: 16 }), { max: 4 })),
  });
  assert.deepEqual(
    validate(schema, { name: "api", mode: "open" }),
    { name: "api", mode: "open" },
  );
  assert.deepEqual(
    validate(schema, { name: "api", mode: "closed", retries: 2, tags: ["a"] }),
    { name: "api", mode: "closed", retries: 2, tags: ["a"] },
  );
});

test("S02: validate rejects malformed input with 422", () => {
  const schema = v.object({
    name: v.string({ min: 1, max: 8, pattern: "^[a-z]+$" }),
    count: v.int({ min: 0 }),
    mode: v.enum(["open", "closed"]),
  });
  invalid(schema, null);
  invalid(schema, { name: "", count: 1, mode: "open" });
  invalid(schema, { name: "TOOLONGNAME", count: 1, mode: "open" });
  invalid(schema, { name: "Abc", count: 1, mode: "open" });
  invalid(schema, { name: "abc", count: 1.5, mode: "open" });
  invalid(schema, { name: "abc", count: -1, mode: "open" });
  invalid(schema, { name: "abc", count: 1, mode: "half" });
  invalid(schema, { name: "abc", count: 1 });
  invalid(schema, { name: "abc", count: 1, mode: "open", extra: "rejected" });
});
