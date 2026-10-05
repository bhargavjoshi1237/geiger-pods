import assert from "node:assert/strict";
import test from "node:test";
import {
  decidePostAuth,
  evaluateResourcePolicy,
  snapshotResourcePolicy,
  validateResourcePolicy,
} from "../../lib/gateway/core/auth/resource-policy.mjs";

const GET_PETS = "arn:pods:execute-api:auto:p1:api1/prod/GET/pets";

function ipDeny() {
  return {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Deny", Action: "execute-api:Invoke", Resource: "*",
      Condition: { IpAddress: { "aws:SourceIp": "10.0.0.0/8" } },
    }],
  };
}

test("S07: resource-policy × auth-type table (§7) — each row a test", () => {
  const allowDoc = {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: "execute-api:Invoke", Resource: "*" }],
  };
  // NONE + Allow → Allow; NONE + implicit (policy exists) → Deny; NONE, no policy → Allow.
  assert.equal(decidePostAuth({ authType: "NONE", resource: "Allow" }), "Allow");
  assert.equal(decidePostAuth({ authType: "NONE", resource: "ImplicitDeny" }), "Deny");
  assert.equal(decidePostAuth({ authType: "NONE", resource: null }), "Allow");
  // Explicit deny beats everything.
  for (const authType of ["NONE", "SIGNED", "CUSTOM", "JWT"]) {
    assert.equal(decidePostAuth({ authType, resource: "Deny", authorizer: "Allow" }), "Deny");
    assert.equal(decidePostAuth({ authType, resource: "Deny", authorizer: "Deny" }), "Deny");
  }
  // SIGNED: Allow → Allow regardless; implicit → identity policy decides; none → identity decides.
  assert.equal(decidePostAuth({ authType: "SIGNED", resource: "Allow", authorizer: "Deny" }), "Allow");
  assert.equal(decidePostAuth({ authType: "SIGNED", resource: "ImplicitDeny", authorizer: "Allow" }), "Allow");
  assert.equal(decidePostAuth({ authType: "SIGNED", resource: "ImplicitDeny", authorizer: "Deny" }), "Deny");
  assert.equal(decidePostAuth({ authType: "SIGNED", resource: null, authorizer: "Allow" }), "Allow");
  assert.equal(decidePostAuth({ authType: "SIGNED", resource: null, authorizer: "Deny" }), "Deny");
  // CUSTOM / JWT: Allow+Allow → Allow; Implicit+Allow → Allow; Deny/401 → Deny.
  for (const authType of ["CUSTOM", "JWT"]) {
    assert.equal(decidePostAuth({ authType, resource: "Allow", authorizer: "Allow" }), "Allow");
    assert.equal(decidePostAuth({ authType, resource: "ImplicitDeny", authorizer: "Allow" }), "Allow");
    assert.equal(decidePostAuth({ authType, resource: "Allow", authorizer: "Deny" }), "Deny");
    assert.equal(decidePostAuth({ authType, resource: null, authorizer: "Allow" }), "Allow");
    assert.equal(decidePostAuth({ authType, resource: null, authorizer: "Deny" }), "Deny");
  }
  void allowDoc;
});

test("S07: resource policy pre-auth deny matches anonymous callers on IP", () => {
  const { decision } = evaluateResourcePolicy({
    document: ipDeny(), resource: GET_PETS,
    request: { sourceIp: "10.1.2.3" }, principalArn: null,
  });
  assert.equal(decision, "Deny");
  assert.equal(evaluateResourcePolicy({
    document: ipDeny(), resource: GET_PETS,
    request: { sourceIp: "8.8.8.8" }, principalArn: null,
  }).decision, "ImplicitDeny");
});

test("S07: resource policy principal matching (Pods + AWS alias, wildcard)", () => {
  const document = {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow", Action: "execute-api:Invoke", Resource: "*",
      Principal: { Pods: ["arn:pods:iam::p1:credential/PKIAAAA"] },
    }],
  };
  assert.equal(evaluateResourcePolicy({
    document, resource: GET_PETS, principalArn: "arn:pods:iam::p1:credential/PKIAAAA",
  }).decision, "Allow");
  assert.equal(evaluateResourcePolicy({
    document, resource: GET_PETS, principalArn: "arn:pods:iam::p1:credential/PKIABBB",
  }).decision, "ImplicitDeny");
  assert.equal(evaluateResourcePolicy({ document, resource: GET_PETS, principalArn: null }).decision, "ImplicitDeny");
  const alias = {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: "execute-api:Invoke", Resource: "*", Principal: { AWS: "*" } }],
  };
  assert.equal(evaluateResourcePolicy({ document: alias, resource: GET_PETS, principalArn: null }).decision, "Allow");
  const star = {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: "execute-api:Invoke", Resource: "*", Principal: "*" }],
  };
  assert.equal(evaluateResourcePolicy({ document: star, resource: GET_PETS, principalArn: null }).decision, "Allow");
});

test("S07: resource policy validation and snapshot", () => {
  assert.deepEqual(validateResourcePolicy({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: "execute-api:Invoke", Resource: "*" }],
  }).errors, []);
  assert.ok(validateResourcePolicy({ Version: "2012-10-17", Statement: [] }).errors.length > 0);
  assert.ok(validateResourcePolicy({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: "execute-api:Invoke", Resource: "*", Principal: { Other: "*" } }],
  }).errors.length > 0);
  assert.equal(snapshotResourcePolicy(null), null);
  assert.throws(() => snapshotResourcePolicy({ Version: "2012-10-17", Statement: [] }), /Invalid resource policy/);
  const snap = snapshotResourcePolicy({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: "execute-api:Invoke", Resource: "*" }],
  });
  assert.equal(snap.Statement[0].Effect, "Allow");
});
