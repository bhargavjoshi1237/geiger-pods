import assert from "node:assert/strict";
import test from "node:test";

import { selectRequestTemplate, selectResponseTemplate } from "../../lib/gateway/core/processing/responses.mjs";
import { GatewayError } from "../../lib/gateway/core/errors.mjs";

const TEMPLATES = {
  "application/json": '{"a": 1}',
  "application/xml": "<a/>",
};

test("S06: passthrough behaviors WHEN_NO_MATCH/WHEN_NO_TEMPLATES/NEVER produce passthrough/415 per table", () => {
  // Exact match wins under every behavior.
  for (const behavior of ["WHEN_NO_MATCH", "WHEN_NO_TEMPLATES", "NEVER"]) {
    const selected = selectRequestTemplate(TEMPLATES, "application/json", behavior);
    assert.equal(selected.template, '{"a": 1}');
  }
  // Absent Content-Type defaults to application/json.
  assert.equal(selectRequestTemplate(TEMPLATES, null, "NEVER").template, '{"a": 1}');
  // Parameters are stripped before matching.
  assert.equal(selectRequestTemplate(TEMPLATES, "application/json; charset=utf-8", "NEVER").template, '{"a": 1}');

  // WHEN_NO_MATCH: unmatched type passes through unchanged.
  assert.deepEqual(selectRequestTemplate(TEMPLATES, "text/plain", "WHEN_NO_MATCH"), { passthrough: true });
  // WHEN_NO_TEMPLATES: templates exist but none match → 415.
  assert.throws(() => selectRequestTemplate(TEMPLATES, "text/plain", "WHEN_NO_TEMPLATES"), (error) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.type, "UNSUPPORTED_MEDIA_TYPE");
    assert.equal(error.statusCode, 415);
    return true;
  });
  // WHEN_NO_TEMPLATES with no templates at all → passthrough.
  assert.deepEqual(selectRequestTemplate({}, "text/plain", "WHEN_NO_TEMPLATES"), { passthrough: true });
  // NEVER: unmatched type → 415 even with an empty table.
  assert.throws(() => selectRequestTemplate(TEMPLATES, "text/plain", "NEVER"), /Unsupported Media Type/);
  assert.throws(() => selectRequestTemplate({}, "text/plain", "NEVER"), /Unsupported Media Type/);

  // Response selection by Accept: exact match, then application/json
  // preference, then first defined, else passthrough (null).
  assert.equal(selectResponseTemplate(TEMPLATES, "application/xml").contentType, "application/xml");
  assert.equal(selectResponseTemplate(TEMPLATES, "text/plain").contentType, "application/json");
  assert.equal(selectResponseTemplate({ "application/xml": "<a/>" }, "text/plain").contentType, "application/xml");
  assert.equal(selectResponseTemplate({}, "text/plain"), null);
  assert.equal(selectResponseTemplate(TEMPLATES, "application/*").contentType, "application/json");
});
