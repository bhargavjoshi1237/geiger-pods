/**
 * S15 part 1 (security): VTL fuzz.
 *
 * A seeded fuzzer renders 10 000 random templates: no exception may escape as
 * anything other than `API_CONFIGURATION_ERROR` (rendered 500 downstream),
 * and no template may pollute `Object.prototype` (`({}).polluted` stays
 * `undefined`).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { parseTemplate } from "../../lib/gateway/core/processing/templates/index.mjs";
import { renderAst } from "../../lib/gateway/core/processing/templates/interpreter.mjs";

/** Deterministic PRNG (mulberry32) so the fuzz corpus is stable in CI. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const ATOMS = [
  "$x", "$input.path('$.a')", "$util.escapeJavaScript($x)", "'lit'", "42",
  "$map.key", "$list.get(0)", "$x.length()", "$x.toString()",
  "$x.replaceAll(\"[a]+\", \"b\")", "$x.split(\",\")", "$x.matches(\"[a-z]+\")",
  "$context.authorizer.claims", "$stageVariables.v", "__proto__", "constructor",
  "prototype", "$x.__proto__", "$map.__proto__", "$map.put('__proto__', 1)",
  "#set($__proto__ = 1)", "$map.put('constructor', 1)", "$map.get('__proto__')",
  "#foreach($i in [1..3])$i#end", "#if($x)$y#else$z#end", "${x}",
];

const WRAPPERS = [
  (inner) => `#set($a = ${inner})$a`,
  (inner) => `#foreach($i in $list)${inner}#end`,
  (inner) => `#if(${inner})ok#end`,
  (inner) => `${inner}${inner}`,
  (inner) => `$map.put('k', ${inner})$map.get('k')`,
  (inner) => `${inner}.toString()`,
];

function randomTemplate(rand) {
  const count = 1 + Math.floor(rand() * 3);
  let out = "";
  for (let i = 0; i < count; i += 1) {
    let atom = ATOMS[Math.floor(rand() * ATOMS.length)];
    if (rand() < 0.4) {
      const wrap = WRAPPERS[Math.floor(rand() * WRAPPERS.length)];
      atom = wrap(atom);
    }
    out += atom + " ";
  }
  if (rand() < 0.1) out += "#set($polluted = 1)";
  return out;
}

function fuzzData() {
  const map = {};
  map.key = "v";
  return {
    input: { x: "abc", path: () => "v" },
    util: { escapeJavaScript: (value) => String(value) },
    context: { authorizer: { claims: {} } },
    stageVariables: { v: "s" },
    map,
    list: ["a", "b"],
    x: "hello",
    y: "Y",
    z: "Z",
  };
}

test("S15: VTL fuzz — no prototype pollution, only API_CONFIGURATION_ERROR failures", () => {
  const rand = seeded(0x51570);
  let rendered = 0;
  let configErrors = 0;
  for (let i = 0; i < 10000; i += 1) {
    const template = randomTemplate(rand);
    let ast;
    try {
      ast = parseTemplate(template);
    } catch {
      configErrors += 1;
      continue;
    }
    try {
      renderAst(ast, fuzzData());
      rendered += 1;
    } catch (error) {
      assert.equal(
        error?.code,
        "API_CONFIGURATION_ERROR",
        `template ${JSON.stringify(template)} threw code ${error?.code} (${error?.message})`,
      );
      configErrors += 1;
    }
    // Pollution check every iteration (cheap own-property read).
    assert.equal(
      ({}).polluted,
      undefined,
      `prototype pollution after template ${JSON.stringify(template)}`,
    );
  }
  assert.ok(rendered > 1000, `expected many templates to render, got ${rendered}`);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});
