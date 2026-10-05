import assert from "node:assert/strict";
import test from "node:test";

import {
  parseTemplate,
  renderTemplate,
} from "../../lib/gateway/core/processing/templates/index.mjs";
import { TemplateLimitError } from "../../lib/gateway/core/processing/templates/interpreter.mjs";
import { validateProcessing } from "../../lib/gateway/core/processing/validate-processing.mjs";

// Golden cases ported from the AWS mapping-template documentation set.
// Each case cites the AWS page its example comes from:
// - REF = Mapping template reference ($input/$util):
//   https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-mapping-template-reference.html
// - DATA = REST data transformations (parameter/override examples):
//   https://docs.aws.amazon.com/apigateway/latest/developerguide/rest-api-data-transformations.html
// - OVERRIDE = Override request/response parameters with templates:
//   https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-override-request-response-parameters.html
// - MODELS = Models/mappings and request validation examples:
//   https://docs.aws.amazon.com/apigateway/latest/developerguide/models-mappings-models.html
// - VTL = Apache Velocity user guide semantics mirrored by AWS's engine.

const BODY_ITEMS = '{"items": [{"id": 1}, {"id": 2}, {"id": 3}]}';

const CASES = [
  // AWS REF: $input.body — "returns the raw payload as a string".
  ["input.body passthrough", "$input.body", { bodyText: '{"a": 1}' }, '{"a": 1}'],
  // AWS REF: $input.json('$.items[0]') — JSON string of the selection.
  ["input.json index", "$input.json('$.items[0]')", { bodyText: BODY_ITEMS }, '{"id":1}'],
  // AWS REF: $input.path('$.name') — object of the selection.
  ["input.path property", "$input.path('$.name')", { bodyText: '{"name": "Ada"}' }, "Ada"],
  // AWS REF: $input.params() — {header, querystring, path}.
  [
    "input.params map",
    "$input.params()",
    { headers: { "X-A": "1" }, querystring: { q: "2" }, pathParams: { id: "3" } },
    '{"header":{"X-A":"1"},"querystring":{"q":"2"},"path":{"id":"3"}}',
  ],
  // AWS REF: $input.params(x) searches path → querystring → header.
  ["input.params path wins", "$input.params('id')", { headers: { id: "h" }, querystring: { id: "q" }, pathParams: { id: "p" } }, "p"],
  ["input.params header fallback", "$input.params('X-A')", { headers: { "X-A": "1" }, querystring: {}, pathParams: {} }, "1"],
  ["input.params missing is empty", "[$input.params('nope')]", {}, "[]"],
  // AWS REF: foreach with $foreach.hasNext comma-join idiom.
  [
    "foreach hasNext commas",
    "#foreach($elem in $input.path('$.items'))$elem.id#if($foreach.hasNext),#end#end",
    { bodyText: BODY_ITEMS },
    "1,2,3",
  ],
  // AWS REF: #if/#elseif/#else conditional rendering.
  ["if elseif else", "#if($context.n == 1)one#elseif($context.n == 2)two#else other#end", { context: { n: 2 } }, "two"],
  // AWS REF: $util.escapeJavaScript for JSON string embedding.
  ["util.escapeJavaScript", '{"name": "$util.escapeJavaScript($input.path(\'$.name\'))"}', { bodyText: '{"name": "a\\"b"}' }, '{"name": "a\\"b"}'],
  // AWS REF: $util.parseJson then property access.
  ["util.parseJson", "#set($o = $util.parseJson('{\"a\":1}'))$o.a", {}, "1"],
  // AWS REF: $util.urlEncode / $util.urlDecode.
  ["util.urlEncode", "$util.urlEncode('a b&c')", {}, "a%20b%26c"],
  ["util.urlDecode round trip", "$util.urlDecode($util.urlEncode('a b&c'))", {}, "a b&c"],
  // AWS REF: $util.base64Encode / $util.base64Decode.
  ["util.base64Encode", "$util.base64Encode('hi')", {}, "aGk="],
  ["util.base64Decode round trip", "$util.base64Decode($util.base64Encode('hi'))", {}, "hi"],
  // AWS OVERRIDE: $context.requestOverride.header/querystring/path.
  ["requestOverride header", "#set($context.requestOverride.header.XAdded = \"yes\")ok", {}, "ok"],
  // AWS OVERRIDE: $context.responseOverride.status/.header.
  ["responseOverride status", "#set($context.responseOverride.status = 201)#set($context.responseOverride.header.XR = \"1\")done", {}, "done"],
  // AWS DATA: $stageVariables.* and $context.* in templates.
  ["stageVariables", "$stageVariables.env", { stageVariables: { env: "prod" } }, "prod"],
  ["context field", "$context.httpMethod $context.stage", { context: { httpMethod: "POST", stage: "prod" } }, "POST prod"],
  // AWS VTL: quiet $! vs loud references and ${…} braces.
  ["quiet missing", "[$!nope]", {}, "[]"],
  ["loud missing renders literally", "$nope", {}, "$nope"],
  ["braced reference", "${context.name}", { context: { name: "Ada" } }, "Ada"],
  // AWS VTL: property chains, [n], [-n], ['k'] indexing.
  ["property chain", "$context.a.b.c", { context: { a: { b: { c: "deep" } } } }, "deep"],
  ["index and negative index", "$context.arr[0] $context.arr[-1]", { context: { arr: ["x", "y"] } }, "x y"],
  ["quoted key index", "#set($m = {\"k\": \"v\"})$m['k']", {}, "v"],
  ["variable index", "#set($i = 1)$context.arr[$i]", { context: { arr: ["a", "b"] } }, "b"],
  // AWS VTL: string methods.
  ["string trim upper lower", "$context.s.trim().toUpperCase().toLowerCase()", { context: { s: "  Pad " } }, "pad"],
  ["string predicates", "#if($context.s.contains(\"ell\") && $context.s.startsWith(\"h\") && $context.s.endsWith(\"o\"))yes#end", { context: { s: "hello" } }, "yes"],
  ["string indexOf substring", "$context.s.indexOf(\"ll\") $context.s.substring(1, 3)", { context: { s: "hello" } }, "2 el"],
  ["string replace replaceAll split", "$context.s.replace(\"a\", \"o\").replaceAll(\"[0-9]\", \"#\") ${\"a,b\".split(\",\")[1]}", { context: { s: "a1" } }, "o# b"],
  ["string equals matches length", "#if(\"ABC\".equalsIgnoreCase(\"abc\") && \"abc\".matches(\"[a-z]+\"))${\"abc\".length()}#end", {}, "3"],
  ["string isEmpty", "#if(\"\".isEmpty())empty#end", {}, "empty"],
  // AWS VTL: list methods.
  ["list size get contains", "$context.list.size() $context.list.get(0) $context.list.contains(20)", { context: { list: [10, 20] } }, "2 10 true"],
  ["list add mutates", "#set($l = [1])#set($ok = $l.add(2))$l.size()", {}, "2"],
  ["list isEmpty falsy", "#if($context.list.isEmpty())empty#end", { context: { list: [] } }, "empty"],
  // AWS VTL: map methods.
  ["map get put containsKey", "#set($m = {})#set($old = $m.put(\"k\", \"v\"))$m.get(\"k\") $m.containsKey(\"k\")", {}, "v true"],
  ["map keySet entrySet size", "#foreach($e in $context.m.entrySet())$e.key=$e.value;#end$context.m.keySet().size()", { context: { m: { a: 1 } } }, "a=1;1"],
  // AWS VTL: ranges, operators, literals.
  ["range loop", "#foreach($i in [1..3])$i;#end", {}, "1;2;3;"],
  ["operators", "#if(3 > 2 && 2 <= 2 || false && not false)yes#if(1 != 2 && !(1 == 2))!#end#end", {}, "yes!"],
  ["arithmetic", "#set($n = 7 % 3)$n #set($d = 7 / 2)$d #set($u = -5)$u", {}, "1 3.5 -5"],
  ["string concat", "#set($s = \"a\" + \"b\")$s", {}, "ab"],
  ["booleans null", "#set($t = 1 == 1)$t#set($n = $missing)$n!", {}, "true!"],
  ["single quotes are literal", "#set($s = 'no $interp')$s", {}, "no $interp"],
  ["double quotes interpolate", "#set($g = \"hi ${context.name}!\")$g", { context: { name: "Bo" } }, "hi Bo!"],
  // AWS VTL: comments and escapes.
  ["line comment", "## hidden\nkept", {}, "\nkept"],
  ["block comment", "a#* hidden $ref *#b", {}, "ab"],
  ["escapes", "\\$notref \\#notdir", {}, "$notref #notdir"],
  // AWS VTL: #break and #stop.
  ["break", "#foreach($i in [1..5])#if($i == 3)#break#end$i;#end", {}, "1;2;"],
  ["stop ends rendering", "a#stop b", {}, "a"],
  // AWS VTL: loop metadata.
  ["velocityCount velocityHasNext", "#foreach($i in [7, 8])$velocityCount:$velocityHasNext;#end", {}, "1:true;2:false;"],
  ["foreach index count", "#foreach($i in [\"a\", \"b\"])$foreach.index/$foreach.count;#end", {}, "0/1;1/2;"],
  // AWS REF: JSONPath variants in $input.json/path.
  ["jsonpath bracket name", "$input.json(\"$['user']\")", { bodyText: '{"user": "Ada"}' }, '"Ada"'],
  ["jsonpath slice", "$input.json('$.items[0:2]')", { bodyText: BODY_ITEMS }, '[{"id":1},{"id":2}]'],
  ["jsonpath wildcard", "$input.json('$.items[*].id')", { bodyText: BODY_ITEMS }, "[1,2,3]"],
  ["jsonpath recursive", "$input.json('$..name')", { bodyText: '{"a": {"name": "deep"}, "name": "top"}' }, '["top","deep"]'],
  ["jsonpath filter", "$input.json('$.items[?(@.id > 1)].id')", { bodyText: BODY_ITEMS }, "[2,3]"],
  ["jsonpath no match is empty", "[$input.json('$.missing')]", { bodyText: '{"a": 1}' }, "[]"],
  // AWS DATA: #set into nested targets.
  ["set nested path", "#set($x = {})#set($x.a.b = \"deep\")$x.a.b", {}, "deep"],
  ["set list index", "#set($l = [1, 2])#set($l[0] = 9)$l[0]", {}, "9"],
  // AWS MODELS: $context.error.* in gateway-response templates.
  ["error messageString quoted", "$context.error.messageString", { context: { error: { message: "Bad", messageString: '"Bad"' } } }, '"Bad"'],
  // Method call on null is lenient (renders empty), like Velocity.
  ["method on null is empty", "#set($m = $missing)[$m.size()]", {}, "[]"],
  // Prototype pollution guards: reads resolve to nothing, writes throw.
  ["proto read is inert", "$context.constructor", { context: {} }, "$context.constructor"],
];

test("S06: VTL conformance suite — 40+ golden cases ported from AWS docs examples (foreach with hasNext commas, #if/else, $util.escapeJavaScript, $input.json('$.items[0]'), $input.params(), requestOverride/responseOverride)", () => {
  assert.ok(CASES.length >= 40, `expected 40+ golden cases, have ${CASES.length}`);
  const failures = [];
  for (const [name, template, req, expected] of CASES) {
    let output;
    try {
      output = renderTemplate(template, req).output;
    } catch (error) {
      failures.push(`${name}: threw ${error.constructor.name}: ${error.message}`);
      continue;
    }
    if (output !== expected) failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(output)}`);
  }
  assert.deepEqual(failures, [], `${failures.length} golden cases failed:\n${failures.join("\n")}`);
});

test("S06: VTL overrides land on the template context for the phase layer", () => {
  const request = renderTemplate("#set($context.requestOverride.header.XAdded = \"yes\")ok", {});
  assert.equal(request.output, "ok");
  assert.equal(request.context.requestOverride.header.XAdded, "yes");
  const response = renderTemplate(
    "#set($context.responseOverride.status = 201)#set($context.responseOverride.header.XR = \"1\")done",
    {},
  );
  assert.equal(response.output, "done");
  assert.equal(response.context.responseOverride.status, 201);
  assert.equal(response.context.responseOverride.header.XR, "1");
});

test("S06: VTL prototype-pollution writes throw instead of polluting", () => {
  assert.throws(() => renderTemplate("#set($m = {})$m.put(\"__proto__\", \"polluted\")", {}), /reserved key/);
  assert.throws(() => renderTemplate("#set($m = {})#set($m.__proto__ = 1)$m", {}), /reserved key/);
  assert.equal({}.polluted, undefined);
});

test("S06: template foreach >1000 iterations → 500 API_CONFIGURATION_ERROR; parse error caught at deploy", () => {
  const big = "#foreach($i in $context.items)$i#end";
  const items = Array.from({ length: 1001 }, (_, index) => index);
  try {
    renderTemplate(big, { context: { items } });
    assert.fail("expected TemplateLimitError");
  } catch (error) {
    assert.ok(error instanceof TemplateLimitError);
    assert.equal(error.code, "API_CONFIGURATION_ERROR");
  }
  // Exactly 1000 iterations is allowed (AWS limit).
  const boundary = renderTemplate("#foreach($i in $context.items)x#end", {
    context: { items: Array.from({ length: 1000 }, () => 0) },
  });
  assert.equal(boundary.output.length, 1000);
  // Syntax errors surface at parse (deploy) time, never at request time.
  assert.throws(() => parseTemplate("#if($a) yes"), /Unclosed directive/);
  assert.throws(() => parseTemplate("#end"), /Unmatched #end/);
  const { errors } = validateProcessing({
    methods: [{
      methodId: "m1",
      requestTemplates: { "application/json": "#if($a) yes" },
      integrationResponses: [],
      methodResponses: [],
    }],
  });
  assert.ok(errors.some((entry) => entry.code === "invalid_template"), JSON.stringify(errors));
});
