/**
 * S11D acceptance: WAF statement coverage, transforms, COUNT/labels,
 * default action, rate-based rules, SQLi/XSS corpus, regex safety.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  applyTransforms,
  extractField,
  evaluateStatement,
  evaluateWebAcl,
  validateStatement,
  validateRegexPattern,
  makeRequest,
} from "../../lib/gateway/core/edge/waf-engine.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";
import { createS11FakeDb, PROJECT, ADMIN } from "./fake-db.mjs";
import { createIpSet, createRegexSet, createWebAcl } from "../../lib/control/waf.mjs";

function req(overrides = {}) {
  return makeRequest({
    method: "GET",
    path: "/pets",
    query: "",
    headers: { "user-agent": "test", "x-country": "US" },
    body: "",
    sourceIp: "203.0.113.7",
    ...overrides,
  });
}

function wctx(overrides = {}) {
  return {
    ipSets: new Map(),
    regexSets: new Map(),
    labels: new Set(),
    country: "US",
    forwardedIp: null,
    kv: new MemoryKvStore({}),
    now: Date.now(),
    ...overrides,
  };
}

test("S11D: each statement type has positive/negative tests; text transformations applied in order; COUNT continues with labels; default action applies", async () => {
  // Text transformations apply in order.
  assert.equal(applyTransforms("  HeLLo%20World  ", ["COMPRESS_WHITE_SPACE", "LOWERCASE", "URL_DECODE"]), "hello world");
  assert.equal(applyTransforms("%41%42", ["URL_DECODE"]), "AB");
  assert.equal(applyTransforms("&#65;&#66;", ["HTML_ENTITY_DECODE"]), "AB");
  assert.equal(applyTransforms("a\x00b", ["REMOVE_NULLS"]), "ab");
  assert.equal(applyTransforms("/a/./b/../c", ["NORMALIZE_PATH"]), "/a/c");
  assert.equal(applyTransforms("cat^ \"/etc^/passwd\"", ["CMD_LINE"]), "cat /etc/passwd");
  assert.equal(applyTransforms(Buffer.from("aB").toString("base64"), ["BASE64_DECODE"]), "aB");
  assert.equal(applyTransforms("ABC", ["NONE"]), "ABC");

  const base = wctx();

  // IPSet: positive + negative.
  const ipCtx = wctx({ ipSets: new Map([["set-1", { ipVersion: "IPV4", addresses: ["203.0.113.0/24"] }]]) });
  assert.equal(evaluateStatement({ type: "IPSetReferenceStatement", ipSetId: "set-1" }, req(), ipCtx).matched, true);
  assert.equal(evaluateStatement({ type: "IPSetReferenceStatement", ipSetId: "set-1" }, req({ sourceIp: "198.51.100.9" }), ipCtx).matched, false);

  // GeoMatch: positive + negative (country from the trusted test header).
  assert.equal(evaluateStatement({ type: "GeoMatchStatement", countryCodes: ["US"] }, req(), base).matched, true);
  assert.equal(evaluateStatement({ type: "GeoMatchStatement", countryCodes: ["DE"] }, req(), base).matched, false);

  // ByteMatch across constraints.
  const byte = (constraint, search) => ({
    type: "ByteMatchStatement",
    fieldToMatch: { UriPath: {} },
    positionalConstraint: constraint,
    searchString: search,
    textTransformations: ["NONE"],
  });
  assert.equal(evaluateStatement(byte("EXACTLY", "/pets"), req(), base).matched, true);
  assert.equal(evaluateStatement(byte("EXACTLY", "/dogs"), req(), base).matched, false);
  assert.equal(evaluateStatement(byte("STARTS_WITH", "/pe"), req(), base).matched, true);
  assert.equal(evaluateStatement(byte("ENDS_WITH", "ets"), req(), base).matched, true);
  assert.equal(evaluateStatement(byte("CONTAINS", "et"), req(), base).matched, true);
  assert.equal(evaluateStatement(byte("CONTAINS_WORD", "pets"), req({ path: "/my-pets/1" }), base).matched, true);
  assert.equal(evaluateStatement(byte("CONTAINS_WORD", "et"), req(), base).matched, false);

  // RegexMatch + RegexPatternSetReference.
  const rxCtx = wctx({ regexSets: new Map([["rs-1", { patterns: ["^/admin", "^/debug"] }]]) });
  assert.equal(evaluateStatement({ type: "RegexMatchStatement", fieldToMatch: { UriPath: {} }, regexString: "^/pet", textTransformations: ["NONE"] }, req(), base).matched, true);
  assert.equal(evaluateStatement({ type: "RegexMatchStatement", fieldToMatch: { UriPath: {} }, regexString: "^/dog", textTransformations: ["NONE"] }, req(), base).matched, false);
  assert.equal(evaluateStatement({ type: "RegexPatternSetReferenceStatement", regexSetId: "rs-1" }, req({ path: "/admin/panel" }), rxCtx).matched, true);
  assert.equal(evaluateStatement({ type: "RegexPatternSetReferenceStatement", regexSetId: "rs-1" }, req(), rxCtx).matched, false);

  // SizeConstraint.
  const size = (op, n) => ({ type: "SizeConstraintStatement", fieldToMatch: { Body: {} }, comparisonOperator: op, size: n });
  assert.equal(evaluateStatement(size("GT", 4), req({ body: "12345" }), base).matched, true);
  assert.equal(evaluateStatement(size("GT", 5), req({ body: "12345" }), base).matched, false);
  assert.equal(evaluateStatement(size("EQ", 5), req({ body: "12345" }), base).matched, true);
  assert.equal(evaluateStatement(size("LE", 5), req({ body: "12345" }), base).matched, true);

  // SQLi + XSS spot checks (corpus thresholds have their own test).
  assert.equal(evaluateStatement({ type: "SqliMatchStatement", fieldToMatch: { SingleQueryArgument: { name: "q" } }, sensitivityLevel: "HIGH" }, req({ query: "q=%27%20OR%201%3D1--" }), base).matched, true);
  assert.equal(evaluateStatement({ type: "SqliMatchStatement", fieldToMatch: { SingleQueryArgument: { name: "q" } }, sensitivityLevel: "LOW" }, req({ query: "q=hello" }), base).matched, false);
  assert.equal(evaluateStatement({ type: "XssMatchStatement", fieldToMatch: { SingleQueryArgument: { name: "q" } } }, req({ query: "q=%3Cscript%3Ealert(1)%3C%2Fscript%3E" }), base).matched, true);
  assert.equal(evaluateStatement({ type: "XssMatchStatement", fieldToMatch: { SingleQueryArgument: { name: "q" } } }, req({ query: "q=hello" }), base).matched, false);

  // And/Or/Not + LabelMatch.
  const isUs = { type: "GeoMatchStatement", countryCodes: ["US"] };
  const isPets = { type: "ByteMatchStatement", fieldToMatch: { UriPath: {} }, positionalConstraint: "EXACTLY", searchString: "/pets", textTransformations: ["NONE"] };
  assert.equal(evaluateStatement({ type: "AndStatement", statements: [isUs, isPets] }, req(), base).matched, true);
  assert.equal(evaluateStatement({ type: "OrStatement", statements: [{ type: "ByteMatchStatement", fieldToMatch: { UriPath: {} }, positionalConstraint: "EXACTLY", searchString: "/dogs", textTransformations: ["NONE"] }, isPets] }, req(), base).matched, true);
  assert.equal(evaluateStatement({ type: "NotStatement", statement: isPets }, req(), base).matched, false);
  assert.equal(evaluateStatement({ type: "NotStatement", statement: isPets }, req({ path: "/dogs" }), base).matched, true);

  // COUNT continues with labels; LabelMatchStatement reads them.
  const acl = {
    name: "labels-acl",
    defaultAction: "ALLOW",
    rules: [
      { name: "count-suspicious", priority: 1, action: "COUNT", statement: isPets, ruleLabels: ["suspicious"] },
      { name: "block-labelled", priority: 2, action: "BLOCK", statement: { type: "LabelMatchStatement", label: "suspicious" } },
    ],
    visibility: { sampledRequests: true, metrics: true },
  };
  const counted = await evaluateWebAcl({ acl, req: req(), wctx: wctx() });
  assert.equal(counted.action, "BLOCK");
  assert.ok(counted.labels.has("suspicious"), "COUNT rule labels must be visible to later rules");

  // Default action applies when nothing terminates.
  const allowDefault = await evaluateWebAcl({
    acl: { name: "a", defaultAction: "ALLOW", rules: [{ name: "miss", priority: 1, action: "BLOCK", statement: { type: "NotStatement", statement: isPets } }], visibility: {} },
    req: req(),
    wctx: wctx(),
  });
  assert.equal(allowDefault.action, "DEFAULT_ALLOW");
  const blockDefault = await evaluateWebAcl({
    acl: { name: "b", defaultAction: "BLOCK", rules: [], visibility: {} },
    req: req(),
    wctx: wctx(),
  });
  assert.equal(blockDefault.action, "DEFAULT_BLOCK");

  // Managed rule group: exclusion + COUNT override keep traffic flowing.
  const grouped = await evaluateWebAcl({
    acl: {
      name: "g",
      defaultAction: "ALLOW",
      rules: [{
        name: "common",
        priority: 1,
        action: "BLOCK",
        overrideAction: "COUNT",
        statement: {
          type: "ManagedRuleGroupStatement",
          name: "PodsCommonRuleSet",
          excludedRules: ["CommonRule_Traversal"],
        },
      }],
      visibility: {},
    },
    req: req({ path: "/../../etc/passwd", query: "f=/etc/passwd" }),
    wctx: wctx(),
  });
  assert.equal(grouped.action, "DEFAULT_ALLOW");
  assert.ok(grouped.labels.size > 0);

  // Save-time validation: geo without a source cannot be saved.
  assert.ok(validateStatement({ type: "GeoMatchStatement", countryCodes: ["US"] }, { allowGeo: false }).length > 0);
  assert.deepEqual(validateStatement({ type: "GeoMatchStatement", countryCodes: ["US"] }, { allowGeo: true }), []);
  assert.ok(validateStatement({ type: "ByteMatchStatement" }, {}).length > 0);

  // Field extraction covers every field type.
  const probe = makeRequest({
    method: "POST",
    path: "/submit",
    query: "a=1&b=2",
    headers: { "x-token": "abc", cookie: "sid=9; theme=dark" },
    body: JSON.stringify({ user: { name: "<script>" } }),
    sourceIp: "203.0.113.7",
  });
  assert.deepEqual(extractField({ UriPath: {} }, probe), ["/submit"]);
  assert.deepEqual(extractField({ Method: {} }, probe), ["POST"]);
  assert.deepEqual(extractField({ SingleHeader: { name: "X-Token" } }, probe), ["abc"]);
  assert.deepEqual(extractField({ AllQueryArguments: {} }, probe).sort(), ["1", "2"]);
  assert.deepEqual(extractField({ JsonBody: { matchScope: "VALUE" } }, probe), ["<script>"]);

  // Control plane: IP sets validate CIDR; an empty ACL saves.
  const db = createS11FakeDb();
  await assert.rejects(
    createIpSet(db, ADMIN, { projectId: PROJECT, input: { name: "bad", ipVersion: "IPV4", addresses: ["not-a-cidr"] } }),
    (error) => error.status === 422,
  );
  const set = await createIpSet(db, ADMIN, { projectId: PROJECT, input: { name: "office", ipVersion: "IPV4", addresses: ["203.0.113.0/24"] } });
  assert.equal(set.body.addresses.length, 1);
  const created = await createWebAcl(db, ADMIN, { projectId: PROJECT, input: { name: "acl-1", defaultAction: "ALLOW", rules: [] } });
  assert.equal(created.body.version, 1);
  await assert.rejects(
    createRegexSet(db, ADMIN, { projectId: PROJECT, input: { name: "evil", patterns: ["(a+)+$"] } }),
    (error) => error.status === 422,
  );
});

test("S11D: rate-based 10 per 60 s per IP blocks the 11th; scope-down statement limits counting", async () => {
  const kv = new MemoryKvStore({});
  const clock = { now: 1_700_000_000_000 };
  const statement = {
    type: "RateBasedStatement",
    limit: 10,
    evaluationWindowSec: 60,
    aggregateKeyType: "IP",
  };
  const ctxFor = (ip) => wctx({ kv, now: clock.now, country: "US" });
  let verdict = null;
  for (let index = 0; index < 10; index += 1) {
    verdict = await evaluateWebAcl({
      acl: { name: "rate", defaultAction: "ALLOW", rules: [{ name: "flood", priority: 1, action: "BLOCK", statement }], visibility: {} },
      req: req({ sourceIp: "203.0.113.7" }),
      wctx: ctxFor("203.0.113.7"),
    });
    assert.equal(verdict.action, "DEFAULT_ALLOW", `request ${index + 1} should pass`);
  }
  verdict = await evaluateWebAcl({
    acl: { name: "rate", defaultAction: "ALLOW", rules: [{ name: "flood", priority: 1, action: "BLOCK", statement }], visibility: {} },
    req: req({ sourceIp: "203.0.113.7" }),
    wctx: ctxFor("203.0.113.7"),
  });
  assert.equal(verdict.action, "BLOCK");

  // A different IP has its own bucket.
  const other = await evaluateWebAcl({
    acl: { name: "rate", defaultAction: "ALLOW", rules: [{ name: "flood", priority: 1, action: "BLOCK", statement }], visibility: {} },
    req: req({ sourceIp: "198.51.100.9" }),
    wctx: ctxFor("198.51.100.9"),
  });
  assert.equal(other.action, "DEFAULT_ALLOW");

  // Scope-down: only /login requests count toward the limit.
  const kv2 = new MemoryKvStore({});
  const scoped = {
    type: "RateBasedStatement",
    limit: 2,
    evaluationWindowSec: 60,
    aggregateKeyType: "IP",
    scopeDownStatement: {
      type: "ByteMatchStatement",
      fieldToMatch: { UriPath: {} },
      positionalConstraint: "STARTS_WITH",
      searchString: "/login",
      textTransformations: ["NONE"],
    },
  };
  const scopedAcl = { name: "scoped", defaultAction: "ALLOW", rules: [{ name: "login-flood", priority: 1, action: "BLOCK", statement: scoped }], visibility: {} };
  for (let index = 0; index < 5; index += 1) {
    const out = await evaluateWebAcl({ acl: scopedAcl, req: req({ path: "/pets" }), wctx: wctx({ kv: kv2, now: clock.now }) });
    assert.equal(out.action, "DEFAULT_ALLOW");
  }
  await evaluateWebAcl({ acl: scopedAcl, req: req({ path: "/login" }), wctx: wctx({ kv: kv2, now: clock.now }) });
  await evaluateWebAcl({ acl: scopedAcl, req: req({ path: "/login" }), wctx: wctx({ kv: kv2, now: clock.now }) });
  const blocked = await evaluateWebAcl({ acl: scopedAcl, req: req({ path: "/login" }), wctx: wctx({ kv: kv2, now: clock.now }) });
  assert.equal(blocked.action, "BLOCK");
});

test("S11D: SQLi/XSS corpus thresholds met; regex sets reject catastrophic patterns", async () => {
  const sqli = (await readFile(new URL("./fixtures/waf/sqli.txt", import.meta.url), "utf8")).split("\n").filter(Boolean);
  const xss = (await readFile(new URL("./fixtures/waf/xss.txt", import.meta.url), "utf8")).split("\n").filter(Boolean);
  const benign = JSON.parse(await readFile(new URL("./fixtures/waf/benign.json", import.meta.url), "utf8"));

  const field = { AllQueryArguments: {} };
  let sqliHits = 0;
  for (const payload of sqli) {
    const out = evaluateStatement(
      { type: "SqliMatchStatement", fieldToMatch: field, sensitivityLevel: "HIGH" },
      req({ query: `q=${encodeURIComponent(payload)}` }),
      wctx(),
    );
    if (out.matched) sqliHits += 1;
  }
  const sqliRate = sqliHits / sqli.length;
  assert.ok(sqliRate >= 0.95, `SQLi detection ${sqliHits}/${sqli.length} < 95%`);

  let xssHits = 0;
  for (const payload of xss) {
    const out = evaluateStatement(
      { type: "XssMatchStatement", fieldToMatch: field },
      req({ query: `q=${encodeURIComponent(payload)}` }),
      wctx(),
    );
    if (out.matched) xssHits += 1;
  }
  const xssRate = xssHits / xss.length;
  assert.ok(xssRate >= 0.95, `XSS detection ${xssHits}/${xss.length} < 95%`);

  let benignHits = 0;
  for (const payload of benign) {
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    const sqliOut = evaluateStatement(
      { type: "SqliMatchStatement", fieldToMatch: { Body: {} }, sensitivityLevel: "HIGH" },
      req({ body: text }),
      wctx(),
    );
    const xssOut = evaluateStatement(
      { type: "XssMatchStatement", fieldToMatch: { Body: {} } },
      req({ body: text }),
      wctx(),
    );
    if (sqliOut.matched || xssOut.matched) benignHits += 1;
  }
  const fpRate = benignHits / benign.length;
  assert.ok(fpRate <= 0.01, `benign false-positive rate ${benignHits}/${benign.length} > 1%`);

  // Regex sets reject catastrophic patterns (backreferences, lookaround,
  // nested quantifiers) and accept safe ones.
  for (const evil of ["(a+)+$", "(a*)*", "(a|b)+c$", "foo(?=bar)", "(?<=a)b", "\\1-backref", "(x+x+)+y"]) {
    assert.notEqual(validateRegexPattern(evil), null, `expected rejection: ${evil}`);
  }
  for (const safe of ["^/admin", "hello|world", "[a-z]+", "\\d{3}-\\d{4}", "foo\\.bar"] ) {
    assert.equal(validateRegexPattern(safe), null, `expected acceptance: ${safe}`);
  }
});
