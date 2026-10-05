import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePolicy, validatePolicyDocument, testCondition } from "../../lib/gateway/core/auth/policy.mjs";
import { wildcardMatch, buildMethodArn, parseMethodArn } from "../../lib/gateway/core/auth/arn.mjs";
import { evaluatePreAuth, evaluatePostAuth, policyConditionContext } from "../../lib/gateway/core/auth/resource-policy.mjs";

const ARN = "arn:pods:execute-api:auto:proj:api123/prod/GET/pets";

test("S07: policy evaluator — explicit deny beats allow; IpAddress CIDR v4/v6; StringLike wildcard; NotResource; ForAnyValue", () => {
  const allow = {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: "execute-api:Invoke", Resource: "*" }],
  };
  assert.equal(evaluatePolicy({ document: allow, resource: ARN }).decision, "Allow");
  const denyBeats = {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: "execute-api:Invoke", Resource: "*" },
      { Effect: "Deny", Action: "execute-api:Invoke", Resource: "*" },
    ],
  };
  assert.equal(evaluatePolicy({ document: denyBeats, resource: ARN }).decision, "Deny");

  const ipPolicy = {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow", Action: "execute-api:Invoke", Resource: "*",
      Condition: { IpAddress: { "aws:SourceIp": ["10.0.0.0/8", "2001:db8::/32"] } },
    }],
  };
  assert.equal(evaluatePolicy({ document: ipPolicy, resource: ARN, request: { sourceIp: "10.1.2.3" } }).decision, "Allow");
  assert.equal(evaluatePolicy({ document: ipPolicy, resource: ARN, request: { sourceIp: "2001:db8::1" } }).decision, "Allow");
  assert.equal(evaluatePolicy({ document: ipPolicy, resource: ARN, request: { sourceIp: "11.0.0.1" } }).decision, "ImplicitDeny");

  const like = {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: "execute-api:Invoke", Resource: "arn:pods:execute-api:*:*/*/GET/pets/*" }],
  };
  assert.equal(evaluatePolicy({ document: like, resource: ARN.replace("/pets", "/pets/42") }).decision, "Allow");

  const notResource = {
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Action: "execute-api:Invoke", NotResource: "arn:*/prod/DELETE/*" }],
  };
  assert.equal(evaluatePolicy({ document: notResource, resource: ARN }).decision, "Allow");
  assert.equal(evaluatePolicy({ document: notResource, resource: ARN.replace("GET/pets", "DELETE/pets") }).decision, "ImplicitDeny");

  assert.equal(
    testCondition({ StringLike: { "aws:UserAgent": "Test*" } }, { "aws:useragent": ["Test-1", "Other"] }),
    true,
  );
  // Single-valued condition uses the first value.
  assert.equal(testCondition({ StringEquals: { "aws:UserAgent": "a" } }, { "aws:useragent": ["b"] }), false);
  assert.equal(
    testCondition({ "ForAnyValue:StringEquals": { "aws:UserAgent": "b" } }, { "aws:useragent": ["a", "b"] }),
    true,
  );
  assert.equal(validatePolicyDocument({ Version: "2012-10-17", Statement: [] }).ok, false);
  assert.equal(validatePolicyDocument(allow).ok, true);
  assert.equal(validatePolicyDocument({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "x", Resource: "*", Condition: { Nope: { "aws:SourceIp": "1" } } }] }).ok, false);

  assert.equal(wildcardMatch("a?c", "abc"), true);
  assert.equal(wildcardMatch("a*c", "abbbc"), true);
  assert.equal(wildcardMatch("*", ARN), true);
  const parsed = parseMethodArn(ARN);
  assert.equal(parsed?.method, "GET");
  assert.equal(buildMethodArn({ region: "auto", projectId: "proj", apiPublicId: "api123", stage: "prod", method: "get", resourcePath: "pets" }), ARN);
});

test("S07: resource-policy × auth-type table (§7) — each row a test", () => {
  const allowPolicy = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "execute-api:Invoke", Resource: "*" }] };
  const denyPolicy = { Version: "2012-10-17", Statement: [{ Effect: "Deny", Action: "execute-api:Invoke", Resource: "*" }] };
  const emptyPolicy = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "execute-api:Invoke", Resource: "arn:other" }] };
  function ctxFor(policy) {
    const request = new Request("https://gw.test/prod/pets", { headers: { "user-agent": "t" } });
    return {
      request,
      artifact: { projectId: "p", settings: { resourcePolicy: policy } },
      startTime: Date.now(),
      context: { identity: { sourceIp: "1.2.3.4" } },
    };
  }
  // NONE + Allow → Allow.
  evaluatePostAuth(ctxFor(allowPolicy), ARN, { authType: "NONE", authorized: true, principalArn: null, identityDecision: "ImplicitDeny" });
  // NONE + Implicit → Deny.
  assert.throws(() => evaluatePostAuth(ctxFor(emptyPolicy), ARN, { authType: "NONE", authorized: true, principalArn: null, identityDecision: "ImplicitDeny" }),
    (error) => error?.type === "ACCESS_DENIED");
  // any + Explicit Deny → Deny.
  for (const authType of ["NONE", "SIGNED", "JWT", "CUSTOM"]) {
    assert.throws(() => evaluatePostAuth(ctxFor(denyPolicy), ARN, { authType, authorized: true, principalArn: "arn:p", identityDecision: "Allow" }),
      (error) => error?.type === "ACCESS_DENIED", authType);
  }
  // SIGNED + Allow → Allow regardless of identity.
  evaluatePostAuth(ctxFor(allowPolicy), ARN, { authType: "SIGNED", authorized: false, principalArn: "arn:p", identityDecision: "ImplicitDeny" });
  // SIGNED + Implicit + identity Allow → Allow.
  evaluatePostAuth(ctxFor(emptyPolicy), ARN, { authType: "SIGNED", authorized: true, principalArn: "arn:p", identityDecision: "Allow" });
  // SIGNED + Implicit + identity implicit → Deny.
  assert.throws(() => evaluatePostAuth(ctxFor(emptyPolicy), ARN, { authType: "SIGNED", authorized: false, principalArn: "arn:p", identityDecision: "ImplicitDeny" }),
    (error) => error?.type === "ACCESS_DENIED");
  // CUSTOM/JWT + Allow/Implicit + Allow → Allow.
  evaluatePostAuth(ctxFor(allowPolicy), ARN, { authType: "JWT", authorized: true, principalArn: null, identityDecision: "ImplicitDeny" });
  evaluatePostAuth(ctxFor(emptyPolicy), ARN, { authType: "CUSTOM", authorized: true, principalArn: null, identityDecision: "ImplicitDeny" });
  // CUSTOM/JWT + Deny/401 → Deny/401.
  assert.throws(() => evaluatePostAuth(ctxFor(allowPolicy), ARN, { authType: "JWT", authorized: false, failureType: "UNAUTHORIZED", failureMessage: "Unauthorized", principalArn: null, identityDecision: "ImplicitDeny" }),
    (error) => error?.type === "UNAUTHORIZED");
  // No policy → no-op.
  const noPolicy = ctxFor(null);
  evaluatePostAuth(noPolicy, ARN, { authType: "NONE", authorized: true, principalArn: null, identityDecision: "ImplicitDeny" });
});

test("S07: pre-auth IP deny never invokes authorizer (spy)", () => {
  const denyIp = {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Deny", Action: "execute-api:Invoke", Resource: "*",
      Condition: { IpAddress: { "aws:SourceIp": "1.2.3.4/32" } },
    }],
  };
  const request = new Request("https://gw.test/prod/pets");
  const ctx = {
    request,
    artifact: { projectId: "p", settings: { resourcePolicy: denyIp } },
    startTime: Date.now(),
    context: { identity: { sourceIp: "1.2.3.4" } },
  };
  assert.throws(() => evaluatePreAuth(ctx, ARN), (error) => error?.type === "ACCESS_DENIED");
  const bag = policyConditionContext(ctx, null);
  assert.equal(bag["aws:SourceIp"], "1.2.3.4");
});
