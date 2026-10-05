import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createHmac } from "node:crypto";
import { presignRequest, verifySignature } from "../../lib/gateway/core/auth/sigv4.mjs";

// Independent SigV4 signer (node:crypto, written from the AWS signing-process
// description) so the engine verifier is tested against a second
// implementation — not against itself.
function awsEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalRequest({ method, url, headers, signedHeaders, payloadHash }) {
  const parsed = new URL(url);
  const path = parsed.pathname.split("/").map((segment) => awsEncode(decodeURIComponent(segment))).join("/") || "/";
  const query = [...parsed.searchParams.entries()]
    .map(([name, value]) => [awsEncode(name), awsEncode(value)])
    .sort(([aName, aVal], [bName, bVal]) => (aName === bName ? (aVal < bVal ? -1 : aVal > bVal ? 1 : 0) : (aName < bName ? -1 : 1)))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonicalHeaders = signedHeaders
    .map((name) => `${name}:${String(headers[name]).trim().replace(/\s+/g, " ")}\n`).join("");
  return [method, path, query, canonicalHeaders, signedHeaders.join(";"), payloadHash].join("\n");
}

function signingKey(secret, dateStamp, region, service) {
  const h = (key, data) => createHmac("sha256", key).update(data, "utf8").digest();
  return h(h(h(h(`AWS4${secret}`, dateStamp), region), service), "aws4_request");
}

function signHeaders({ method, url, headers, body = "", accessKeyId, secretAccessKey, region, service, amzDate }) {
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = createHash("sha256").update(body, "utf8").digest("hex");
  const signedHeaders = Object.keys(headers).map((name) => name.toLowerCase()).sort();
  const lowered = {};
  for (const [name, value] of Object.entries(headers)) lowered[name.toLowerCase()] = value;
  lowered.host = new URL(url).host;
  const signed = [...new Set([...signedHeaders, "host"])].sort();
  const withDate = { ...lowered, "x-amz-date": amzDate };
  const all = [...new Set([...signed, "x-amz-date"])].sort();
  const canonical = canonicalRequest({ method, url, headers: withDate, signedHeaders: all, payloadHash });
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonical, "utf8").digest("hex")].join("\n");
  const signature = createHmac("sha256", signingKey(secretAccessKey, dateStamp, region, service)).update(stringToSign, "utf8").digest("hex");
  return {
    headers: { ...withDate, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${all.join(";")}, Signature=${signature}` },
    canonical,
    signature,
  };
}

function signPresigned({ method, url, accessKeyId, secretAccessKey, region, service, amzDate, expires }) {
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const parsed = new URL(url);
  parsed.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  parsed.searchParams.set("X-Amz-Credential", `${accessKeyId}/${scope}`);
  parsed.searchParams.set("X-Amz-Date", amzDate);
  parsed.searchParams.set("X-Amz-Expires", String(expires));
  parsed.searchParams.set("X-Amz-SignedHeaders", "host");
  const canonical = canonicalRequest({
    method, url: parsed.toString(), headers: { host: parsed.host }, signedHeaders: ["host"], payloadHash: "UNSIGNED-PAYLOAD",
  });
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonical, "utf8").digest("hex")].join("\n");
  const signature = createHmac("sha256", signingKey(secretAccessKey, dateStamp, region, service)).update(stringToSign, "utf8").digest("hex");
  parsed.searchParams.set("X-Amz-Signature", signature);
  return parsed.toString();
}

const NOW = Date.UTC(2026, 7, 30, 12, 36, 0);
const AMZ = "20260830T123600Z";
const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const STORE = { AKIDEXAMPLE: { secretAccessKey: SECRET, status: "ACTIVE" } };
const lookupSecret = async (id) => STORE[id] ?? null;

function getRequest(url, headers, body = null) {
  return new Request(url, { method: body === null ? "GET" : "POST", headers, body });
}

test("S07: SigV4 golden vectors — get-vanilla canonical shape verifies", async () => {
  const signed = signHeaders({
    method: "GET", url: "http://host.foo.com/", headers: { host: "host.foo.com" },
    accessKeyId: "AKIDEXAMPLE", secretAccessKey: SECRET, region: "auto", service: "execute-api", amzDate: AMZ,
  });
  // The documented AWS canonical-request shape for get-vanilla (empty body hash).
  assert.equal(signed.canonical, [
    "GET", "/", "",
    "host:host.foo.com", "x-amz-date:20260830T123600Z", "", "host;x-amz-date",
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  ].join("\n"));
  const request = getRequest("http://host.foo.com/", signed.headers);
  const verified = await verifySignature(request, { region: "auto", lookupSecret, now: NOW });
  assert.equal(verified.accessKeyId, "AKIDEXAMPLE");
});

test("S07: SigV4 golden vectors — post-x-www-form-urlencoded and query-order-key verify", async () => {
  const form = signHeaders({
    method: "POST", url: "http://host.foo.com/", body: "Param1=value1",
    headers: { host: "host.foo.com", "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    accessKeyId: "AKIDEXAMPLE", secretAccessKey: SECRET, region: "auto", service: "execute-api", amzDate: AMZ,
  });
  const formRequest = new Request("http://host.foo.com/", { method: "POST", headers: form.headers, body: "Param1=value1" });
  assert.equal((await verifySignature(formRequest, { region: "auto", lookupSecret, now: NOW })).accessKeyId, "AKIDEXAMPLE");

  // Query params out of order on the wire canonicalize to sorted order.
  const ordered = signHeaders({
    method: "GET", url: "http://host.foo.com/?Param2=value2&Param1=value1", headers: { host: "host.foo.com" },
    accessKeyId: "AKIDEXAMPLE", secretAccessKey: SECRET, region: "auto", service: "execute-api", amzDate: AMZ,
  });
  assert.match(ordered.canonical.split("\n")[2], /^Param1=value1&Param2=value2$/);
  const orderedRequest = getRequest("http://host.foo.com/?Param2=value2&Param1=value1", ordered.headers);
  assert.equal((await verifySignature(orderedRequest, { region: "auto", lookupSecret, now: NOW })).accessKeyId, "AKIDEXAMPLE");
});

test("S07: SigV4 tampered body fails; skew 6 min fails; unknown/inactive key fails", async () => {
  const signed = signHeaders({
    method: "POST", url: "http://host.foo.com/", body: "Param1=value1",
    headers: { host: "host.foo.com" },
    accessKeyId: "AKIDEXAMPLE", secretAccessKey: SECRET, region: "auto", service: "execute-api", amzDate: AMZ,
  });
  const tampered = new Request("http://host.foo.com/", { method: "POST", headers: signed.headers, body: "Param1=evil" });
  await assert.rejects(verifySignature(tampered, { region: "auto", lookupSecret, now: NOW }), (error) => error.type === "INVALID_SIGNATURE");

  // 6 minutes of skew → Signature expired.
  const getSigned = signHeaders({
    method: "GET", url: "http://host.foo.com/", headers: { host: "host.foo.com" },
    accessKeyId: "AKIDEXAMPLE", secretAccessKey: SECRET, region: "auto", service: "execute-api", amzDate: AMZ,
  });
  await assert.rejects(
    verifySignature(getRequest("http://host.foo.com/", getSigned.headers), { region: "auto", lookupSecret, now: NOW + 6 * 60 * 1000 }),
    (error) => error.type === "INVALID_SIGNATURE" && /Signature expired/.test(error.message),
  );
  // Unknown key → invalid token; inactive key → invalid token.
  const unknown = signHeaders({
    method: "GET", url: "http://host.foo.com/", headers: { host: "host.foo.com" },
    accessKeyId: "NOPE", secretAccessKey: SECRET, region: "auto", service: "execute-api", amzDate: AMZ,
  });
  await assert.rejects(
    verifySignature(getRequest("http://host.foo.com/", unknown.headers), { region: "auto", lookupSecret, now: NOW }),
    (error) => error.type === "INVALID_SIGNATURE" && /security token/.test(error.message),
  );
  const inactive = async (id) => ({ secretAccessKey: SECRET, status: "INACTIVE" });
  await assert.rejects(
    verifySignature(getRequest("http://host.foo.com/", getSigned.headers), { region: "auto", lookupSecret: inactive, now: NOW }),
    (error) => error.type === "INVALID_SIGNATURE" && /security token/.test(error.message),
  );
  // No auth at all → MISSING_AUTHENTICATION_TOKEN.
  await assert.rejects(
    verifySignature(getRequest("http://host.foo.com/", {}), { region: "auto", lookupSecret, now: NOW }),
    (error) => error.type === "MISSING_AUTHENTICATION_TOKEN",
  );
  // Wrong region → mismatch.
  await assert.rejects(
    verifySignature(getRequest("http://host.foo.com/", getSigned.headers), { region: "eu", lookupSecret, now: NOW }),
    (error) => error.type === "INVALID_SIGNATURE",
  );
});

test("S07: SigV4 UNSIGNED-PAYLOAD honored; presigned URL works then expires", async () => {
  // UNSIGNED-PAYLOAD: body is not hashed, so verification ignores the bytes.
  const canonical = canonicalRequest({
    method: "POST", url: "http://host.foo.com/",
    headers: { host: "host.foo.com", "x-amz-date": AMZ, "x-amz-content-sha256": "UNSIGNED-PAYLOAD" },
    signedHeaders: ["host", "x-amz-content-sha256", "x-amz-date"], payloadHash: "UNSIGNED-PAYLOAD",
  });
  const scope = `20260830/auto/execute-api/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", AMZ, scope, createHash("sha256").update(canonical, "utf8").digest("hex")].join("\n");
  const signature = createHmac("sha256", signingKey(SECRET, "20260830", "auto", "execute-api")).update(stringToSign, "utf8").digest("hex");
  const headers = {
    host: "host.foo.com", "x-amz-date": AMZ, "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    authorization: `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
  };
  const request = new Request("http://host.foo.com/", { method: "POST", headers, body: "anything-at-all" });
  assert.equal((await verifySignature(request, { region: "auto", lookupSecret, now: NOW })).accessKeyId, "AKIDEXAMPLE");

  // Presigned URL (independent signer): works now, expires later.
  const presignedUrl = signPresigned({
    method: "GET", url: "http://host.foo.com/pets?x=1",
    accessKeyId: "AKIDEXAMPLE", secretAccessKey: SECRET, region: "auto", service: "execute-api", amzDate: AMZ, expires: 60,
  });
  const presigned = await verifySignature(new Request(presignedUrl), { region: "auto", lookupSecret, now: NOW });
  assert.equal(presigned.accessKeyId, "AKIDEXAMPLE");
  await assert.rejects(
    verifySignature(new Request(presignedUrl), { region: "auto", lookupSecret, now: NOW + 61 * 1000 }),
    (error) => error.type === "EXPIRED_TOKEN",
  );
  // The repo's own presigner round-trips through the verifier too.
  const own = await presignRequest({
    method: "GET", url: "http://host.foo.com/pets", region: "auto",
    accessKeyId: "AKIDEXAMPLE", secretAccessKey: SECRET, timestamp: NOW, expiresSeconds: 60,
  });
  assert.equal((await verifySignature(new Request(own.url), { region: "auto", lookupSecret, now: NOW })).accessKeyId, "AKIDEXAMPLE");
});
