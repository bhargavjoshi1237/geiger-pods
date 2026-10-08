/**
 * S11A acceptance: domains, verification, certificates, mappings, routing
 * modes, wildcards (engine + control, no network).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createS11FakeDb, PROJECT, ADMIN } from "./fake-db.mjs";
import {
  matchDomain,
  resolveMapping,
  resolveCustomDomain,
  dnsRecordsFor,
  checkDohTxtAnswer,
  validateBasePath,
} from "../../lib/gateway/core/edge/host-resolve.mjs";
import {
  evaluateRoutingRules,
  validateRoutingRule,
  isRestrictedHeader,
  RESTRICTED_CONDITION_HEADERS,
} from "../../lib/gateway/core/edge/routing-rules.mjs";
import { validateImportedCert } from "../../lib/gateway/core/edge/certs.mjs";
import {
  createDomain,
  verifyDomain,
  importCertificate,
  createMapping,
} from "../../lib/control/domains.mjs";

const CERTS = new URL("./fixtures/certs/", import.meta.url);
async function load(name) {
  return readFile(new URL(name, CERTS), "utf8");
}

test("S11A: unverified domain never routes; TXT verification moves to PENDING_CERTIFICATE (DoH mocked)", async () => {
  const db = createS11FakeDb();
  const created = await createDomain(db, ADMIN, {
    projectId: PROJECT,
    input: { domainName: "api.example.com" },
  });
  assert.equal(created.body.status, "PENDING_VERIFICATION");
  assert.match(created.body.verificationToken, /^[A-Za-z0-9_-]{16,}$/);
  assert.deepEqual(created.dnsRecords.map((record) => record.type).sort(), ["CNAME", "TXT"]);

  // An unverified domain never routes: the resolver refuses before matching.
  const refused = resolveCustomDomain({
    host: "api.example.com",
    path: "/pets",
    headers: {},
    domain: { domainName: "api.example.com", status: "PENDING_VERIFICATION", routingMode: "API_MAPPING_ONLY" },
    mappings: [{ apiId: "a1", stage: "prod", basePath: "" }],
    rules: [],
  });
  assert.equal(refused.error, "forbidden");

  // DoH TXT answer carrying the token moves the domain forward.
  const dohFetch = async () => ({
    ok: true,
    async json() {
      return { Answer: [{ data: `"${created.body.verificationToken}"` }] };
    },
  });
  const verified = await verifyDomain(db, ADMIN, {
    projectId: PROJECT,
    domainId: created.body.id,
    dohFetch,
  });
  assert.equal(verified.status, "PENDING_CERTIFICATE");

  // A wrong token stays pending.
  const db2 = createS11FakeDb();
  const other = await createDomain(db2, ADMIN, { projectId: PROJECT, input: { domainName: "other.example.com" } });
  const badFetch = async () => ({ ok: true, async json() { return { Answer: [{ data: '"wrong-token"' }] }; } });
  await assert.rejects(
    verifyDomain(db2, ADMIN, { projectId: PROJECT, domainId: other.body.id, dohFetch: badFetch }),
    (error) => error.code === "verification_failed",
  );

  // Pure DoH answer parsing: quoted, unquoted, absent.
  assert.equal(checkDohTxtAnswer({ Answer: [{ data: '"tok-1"' }] }, "tok-1"), true);
  assert.equal(checkDohTxtAnswer({ Answer: [{ data: "tok-1" }] }, "tok-1"), true);
  assert.equal(checkDohTxtAnswer({ Answer: [{ data: '"other"' }] }, "tok-1"), false);
  assert.equal(checkDohTxtAnswer({}, "tok-1"), false);
});

test("S11A: imported cert with mismatched key or wrong SAN rejected", async () => {
  const alphaCert = await load("alpha.pem");
  const alphaKey = await load("alpha.key");
  const betaKey = await load("beta.key");

  // Mismatched key rejected.
  const mismatched = validateImportedCert({
    certificateChainPem: alphaCert,
    privateKeyPem: betaKey,
    domainName: "alpha.example.com",
  });
  assert.ok(mismatched.errors.length > 0, "expected a key-mismatch error");
  assert.match(mismatched.errors.join(" "), /key/i);

  // Wrong SAN rejected.
  const wrongSan = validateImportedCert({
    certificateChainPem: alphaCert,
    privateKeyPem: alphaKey,
    domainName: "other.example.com",
  });
  assert.ok(wrongSan.errors.length > 0, "expected a SAN error");

  // Correct pair accepted.
  const ok = validateImportedCert({
    certificateChainPem: alphaCert,
    privateKeyPem: alphaKey,
    domainName: "alpha.example.com",
  });
  assert.deepEqual(ok.errors, []);

  // Control plane rejects the same inputs with 422.
  const db = createS11FakeDb();
  const created = await createDomain(db, ADMIN, { projectId: PROJECT, input: { domainName: "alpha.example.com" } });
  await assert.rejects(
    importCertificate(db, ADMIN, { projectId: PROJECT, domainId: created.body.id, chainPem: alphaCert, keyPem: betaKey }),
    (error) => error.status === 422,
  );
  await assert.rejects(
    importCertificate(db, ADMIN, { projectId: PROJECT, domainId: created.body.id, chainPem: alphaCert, keyPem: alphaKey, domainName: "other.example.com" }),
    (error) => error.status === 422,
  );
});

test("S11A: longest base path wins (a/b over a); '' mapping fallback; no match → 403", async () => {
  const mappings = [
    { apiId: "a1", stage: "prod", basePath: "" },
    { apiId: "a1", stage: "prod", basePath: "a" },
    { apiId: "a2", stage: "v2", basePath: "a/b" },
  ];
  assert.equal(validateBasePath("a/b/c"), null);
  assert.equal(validateBasePath(""), null);
  assert.match(validateBasePath("/leading") ?? "", /leading/i);
  assert.match(validateBasePath("trailing/") ?? "", /trailing/i);
  assert.match(validateBasePath("bad segment") ?? "", /segment/i);

  const deep = resolveMapping(mappings, "/a/b/c/d");
  assert.equal(deep.mapping.basePath, "a/b");
  assert.equal(deep.stripped, "/c/d");

  const shallow = resolveMapping(mappings, "/a/other");
  assert.equal(shallow.mapping.basePath, "a");
  assert.equal(shallow.stripped, "/other");

  const root = resolveMapping(mappings, "/");
  assert.equal(root.mapping.basePath, "");
  assert.equal(root.stripped, "/");

  // Segment boundaries: /abc must not match base path "a".
  const boundary = resolveMapping(mappings, "/abc");
  assert.equal(boundary.mapping.basePath, "");

  // No '' mapping and no prefix match → null (the caller returns 403).
  const strict = resolveMapping([{ apiId: "a1", stage: "prod", basePath: "a" }], "/other");
  assert.equal(strict, null);

  const noMatch = resolveCustomDomain({
    host: "api.example.com",
    path: "/other",
    headers: {},
    domain: { domainName: "api.example.com", status: "AVAILABLE", routingMode: "API_MAPPING_ONLY" },
    mappings: [{ apiId: "a1", stage: "prod", basePath: "a" }],
    rules: [],
  });
  assert.equal(noMatch.error, "forbidden");

  // Control plane enforces unique (domain, base_path).
  const db = createS11FakeDb();
  const created = await createDomain(db, ADMIN, { projectId: PROJECT, input: { domainName: "api.example.com" } });
  await db.seedApi({ id: "a1", public_id: "a1" });
  await createMapping(db, ADMIN, { projectId: PROJECT, domainId: created.body.id, input: { apiId: "a1", stage: "prod", basePath: "a" } });
  await assert.rejects(
    createMapping(db, ADMIN, { projectId: PROJECT, domainId: created.body.id, input: { apiId: "a1", stage: "prod", basePath: "a" } }),
    (error) => error.status === 409,
  );
});

test("S11A: ROUTING_RULE_THEN_API_MAPPING falls back to mappings; ROUTING_RULE_ONLY → 404 on no match; restricted header rejected", async () => {
  const domain = { domainName: "api.example.com", status: "AVAILABLE", routingMode: "ROUTING_RULE_THEN_API_MAPPING" };
  const mappings = [{ apiId: "fallback", stage: "prod", basePath: "" }];
  const rules = [{
    id: "rule-1",
    priority: 10,
    conditions: { matchHeaders: [{ header: "x-version", valueGlob: "v2*" }] },
    action: { invokeApi: { apiId: "v2", stage: "prod", stripBasePath: false } },
  }];

  const matched = resolveCustomDomain({
    host: "api.example.com", path: "/pets", headers: { "x-version": "v2beta" },
    domain, mappings, rules,
  });
  assert.equal(matched.apiId, "v2");
  assert.equal(matched.routingRuleId, "rule-1");

  const fallback = resolveCustomDomain({
    host: "api.example.com", path: "/pets", headers: { "x-version": "v1" },
    domain, mappings, rules,
  });
  assert.equal(fallback.apiId, "fallback");
  assert.equal(fallback.routingRuleId, null);

  const only = resolveCustomDomain({
    host: "api.example.com", path: "/pets", headers: { "x-version": "v1" },
    domain: { ...domain, routingMode: "ROUTING_RULE_ONLY" }, mappings, rules,
  });
  assert.equal(only.error, "notFound");

  // Restricted headers are rejected at save time.
  assert.ok(RESTRICTED_CONDITION_HEADERS.has("authorization"));
  assert.ok(isRestrictedHeader("x-pods-test"));
  assert.ok(isRestrictedHeader("X-AMZN-trace-id"));
  const errors = validateRoutingRule({
    priority: 1,
    conditions: { matchHeaders: [{ header: "Authorization", valueGlob: "x*" }] },
    action: { invokeApi: { apiId: "a", stage: "s", stripBasePath: false } },
  });
  assert.ok(errors.length > 0, "expected a restricted-header error");
});

test("S11A: wildcard domain *.example.com routes a.example.com; domainPrefix = a", async () => {
  const exact = matchDomain("api.example.com", "api.example.com");
  assert.equal(exact.matched, true);
  assert.equal(exact.wildcard, false);

  const wild = matchDomain("*.example.com", "a.example.com");
  assert.equal(wild.matched, true);
  assert.equal(wild.wildcard, true);
  assert.equal(wild.domainPrefix, "a");

  // One level only: deeper labels do not match.
  assert.equal(matchDomain("*.example.com", "a.b.example.com").matched, false);
  assert.equal(matchDomain("*.example.com", "example.com").matched, false);
  assert.equal(matchDomain("api.example.com", "other.example.com").matched, false);

  // Full resolution carries the prefix through.
  const resolved = resolveCustomDomain({
    host: "a.example.com",
    path: "/pets",
    headers: {},
    domain: { domainName: "*.example.com", status: "AVAILABLE", routingMode: "API_MAPPING_ONLY" },
    mappings: [{ apiId: "a1", stage: "prod", basePath: "" }],
    rules: [],
  });
  assert.equal(resolved.apiId, "a1");
  assert.equal(resolved.domainPrefix, "a");

  // DNS records for a wildcard use the parent for the challenge.
  const records = dnsRecordsFor({ domainName: "*.example.com", verificationToken: "tok", targetHostname: "d-1.gw.example" });
  const txt = records.find((record) => record.type === "TXT");
  assert.match(txt.name, /_pods-challenge\.example\.com/);
});
