import assert from "node:assert/strict";
import test from "node:test";
import { GatewayError } from "../../lib/gateway/core/errors.mjs";
import { signRequest } from "../../lib/gateway/core/auth/sigv4.mjs";
import {
  AWS_SUBTYPES,
  buildRestAwsRequest,
  buildSubtypeRequest,
} from "../../lib/gateway/core/integrations/aws.mjs";
import { invokeAws } from "../../lib/gateway/core/integrations/index.mjs";
import { buildContext } from "../../lib/gateway/core/context.mjs";

const CREDS = {
  service: "iam",
  region: "us-east-1",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  timestamp: Date.UTC(2015, 7, 30, 12, 36, 0),
};

test("S04: SigV4 signer produces the AWS reference Authorization shape", async () => {
  const signed = await signRequest({
    method: "GET",
    url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
    headers: {},
    body: "",
    ...CREDS,
  });
  assert.equal(signed.headers["x-amz-date"], "20150830T123600Z");
  assert.equal(signed.headers.host, "iam.amazonaws.com");
  assert.match(
    signed.authorization,
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/iam\/aws4_request, SignedHeaders=host;x-amz-date, Signature=[0-9a-f]{64}$/,
  );
  // Exact reference check for this vector (cross-checked against an
  // independent node:crypto HMAC chain, which agrees).
  assert.ok(
    signed.authorization.endsWith("Signature=b2e4af44cfad96d9ffa3c5653674a927b9b0995c33de22e1f843745ce37c1d5e"),
    `unexpected signature: ${signed.authorization}`,
  );
  // Deterministic and sensitive to inputs.
  const again = await signRequest({
    method: "GET",
    url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
    headers: {},
    body: "",
    ...CREDS,
  });
  assert.equal(again.authorization, signed.authorization);
  const other = await signRequest({
    method: "POST",
    url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
    headers: {},
    body: "{}",
    ...CREDS,
  });
  assert.notEqual(other.authorization, signed.authorization);
  const withToken = await signRequest({
    method: "GET",
    url: "https://iam.amazonaws.com/",
    headers: {},
    body: "",
    ...CREDS,
    sessionToken: "SESSION123",
  });
  assert.equal(withToken.headers["x-amz-security-token"], "SESSION123");
  assert.match(withToken.authorization, /SignedHeaders=host;x-amz-date;x-amz-security-token/);
});

test("S04: AWS_SERVICE subtype table builds correct requests and rejects missing params", async () => {
  assert.ok(Object.keys(AWS_SUBTYPES).length >= 10);
  const sqs = buildSubtypeRequest("SQS-SendMessage", {
    QueueUrl: "https://sqs.us-east-1.amazonaws.com/123/q",
    MessageBody: "hello",
  }, { region: "us-east-1" });
  assert.equal(sqs.method, "POST");
  assert.equal(sqs.url, "https://sqs.us-east-1.amazonaws.com/");
  assert.match(sqs.headers["content-type"], /x-www-form-urlencoded/);
  assert.match(sqs.body, /Action=SendMessage/);
  assert.match(sqs.body, /MessageBody=hello/);

  const events = buildSubtypeRequest("EventBridge-PutEvents", { Entries: [{ Source: "pods" }] }, { region: "eu-west-1" });
  assert.equal(events.headers["x-amz-target"], "AWSEvents.PutEvents");
  assert.deepEqual(JSON.parse(events.body).Entries, [{ Source: "pods" }]);

  const appconfig = buildSubtypeRequest("AppConfig-GetConfiguration", {
    Application: "app", Environment: "prod", Configuration: "flags",
  }, { region: "us-east-1" });
  assert.equal(appconfig.method, "GET");
  assert.equal(appconfig.url, "https://appconfig.us-east-1.amazonaws.com/applications/app/environments/prod/configurations/flags");

  // Config problems are API_CONFIGURATION_ERROR (500), never a wrapped 504:
  // the wire message stays generic while the detail rides in `extra`.
  assert.throws(
    () => buildSubtypeRequest("SQS-SendMessage", { QueueUrl: "q" }, { region: "us-east-1" }),
    (error) => error instanceof GatewayError && error.type === "API_CONFIGURATION_ERROR"
      && error.extra?.reason === "missing-params" && /MessageBody/.test(error.extra?.message ?? ""),
  );
  assert.throws(
    () => buildSubtypeRequest("NOPE-X", {}, { region: "us-east-1" }),
    (error) => error instanceof GatewayError && error.type === "API_CONFIGURATION_ERROR"
      && error.extra?.reason === "unknown-subtype",
  );

  const rest = buildRestAwsRequest({ service: "sqs", region: "us-east-1", action: "SendMessage", parameters: { QueueUrl: "q" } });
  assert.match(rest.body, /Action=SendMessage/);
});

test("S04: AWS_SERVICE invoke signs with the vault credentials", async () => {
  let seen = null;
  const ports = {
    fetch: async (url, init) => {
      seen = { url, headers: init.headers };
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
    secrets: {
      async resolve(ref) {
        assert.equal(ref, "secret:aws1");
        return { kind: "aws_credentials", value: { accessKeyId: "AKID", secretAccessKey: "SECRET" } };
      },
    },
  };
  const ctx = buildContext(new Request("https://gw.test/prod/x"), { protocol: "REST", stage: "prod" }, {});
  ctx.signal = new AbortController().signal;
  const result = await invokeAws(ctx, {
    type: "AWS_SERVICE",
    timeout_ms: 5000,
    aws: { subtype: "SQS-SendMessage", region: "us-east-1", roleSecretRef: "secret:aws1" },
  }, { awsParams: { QueueUrl: "https://sqs.us-east-1.amazonaws.com/123/q", MessageBody: "hi" } }, ports);
  assert.equal(result.status, 200);
  assert.equal(seen.url, "https://sqs.us-east-1.amazonaws.com/");
  assert.match(seen.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/us-east-1\/sqs\/aws4_request/);
});
