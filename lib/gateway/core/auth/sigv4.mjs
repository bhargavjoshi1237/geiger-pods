/**
 * SigV4 signing and verification (S04 §3.5 signer, S07 consumer auth).
 *
 * `signRequest` signs outbound backend requests (Lambda Invoke API, AWS
 * service integrations, `aws_sigv4` backend auth). `verifySignature`
 * verifies consumer SigV4 authorization (the IAM equivalent) for header
 * auth and presigned query auth. `presignRequest` builds presigned URLs.
 *
 * Standard SigV4 (`AWS4-HMAC-SHA256`): canonical request → string to sign →
 * derived signing key. Uses WebCrypto so the engine core stays free of
 * Node-only APIs.
 *
 * @module lib/gateway/core/auth/sigv4
 */

const textEncoder = new TextEncoder();

async function hmac(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key instanceof Uint8Array ? key : textEncoder.encode(String(key)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const input = data instanceof Uint8Array ? data : textEncoder.encode(String(data));
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, input));
}

async function sha256Hex(data) {
  const input = data instanceof Uint8Array ? data : textEncoder.encode(String(data));
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function amzDateString(when) {
  const date = when instanceof Date ? when : new Date(when);
  const pad = (num) => String(num).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

function canonicalQuery(url) {
  return [...url.searchParams.entries()]
    .map(([name, value]) => [encodeURIComponent(name), encodeURIComponent(value)])
    .sort(([aName, aVal], [bName, bVal]) => (aName === bName ? (aVal < bVal ? -1 : aVal > bVal ? 1 : 0) : (aName < bName ? -1 : 1)))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function canonicalPath(url) {
  return url.pathname.split("/").map((segment) => encodeURIComponent(decodeURIComponent(segment))).join("/") || "/";
}

function canonicalHeadersText(headers, signedNames) {
  return signedNames.map((name) => `${name}:${headers[name].replace(/\s+/g, " ")}\n`).join("");
}

/**
 * Builds the canonical request and string to sign.
 *
 * @param {{ method: string, url: URL, headers: Record<string,string>, signedNames: Array<string>, payloadHash: string, amzDate: string, scope: string }} input
 * @returns {Promise<{ canonicalRequest: string, stringToSign: string }>}
 */
async function buildStringToSign(input) {
  const canonicalRequest = [
    input.method,
    canonicalPath(input.url),
    canonicalQuery(input.url),
    canonicalHeadersText(input.headers, input.signedNames),
    input.signedNames.join(";"),
    input.payloadHash,
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", input.amzDate, input.scope, await sha256Hex(canonicalRequest)].join("\n");
  return { canonicalRequest, stringToSign };
}

async function deriveSignature(secretAccessKey, dateStamp, region, service, stringToSign) {
  const kDate = await hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const key = await crypto.subtle.importKey("raw", kSigning, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(stringToSign))));
}

/**
 * Signs an outbound request with SigV4.
 *
 * @param {{ method?: string, url: string | URL, headers?: Record<string,string>, body?: string | Uint8Array | null, service: string, region: string, accessKeyId: string, secretAccessKey: string, sessionToken?: string | null, timestamp?: number | Date, unsignedPayload?: boolean }} input
 * @returns {Promise<{ url: string, method: string, headers: Record<string,string>, authorization: string, amzDate: string, payloadHash: string }>}
 */
export async function signRequest(input) {
  const {
    service,
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken = null,
    timestamp = Date.now(),
  } = input ?? {};
  if (!service || !region || !accessKeyId || !secretAccessKey) {
    throw new TypeError("signRequest requires service, region, accessKeyId and secretAccessKey.");
  }
  const url = input.url instanceof URL ? new URL(input.url.toString()) : new URL(input.url);
  const method = String(input.method ?? "GET").toUpperCase();
  const amzDate = amzDateString(timestamp);
  const dateStamp = amzDate.slice(0, 8);

  const body = input.body ?? "";
  const bodyBytes = typeof body === "string" ? textEncoder.encode(body) : body;
  const payloadHash = input.unsignedPayload ? "UNSIGNED-PAYLOAD" : await sha256Hex(bodyBytes);

  const headers = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    headers[String(name).toLowerCase()] = String(value).trim();
  }
  headers.host = url.host;
  headers["x-amz-date"] = amzDate;
  if (sessionToken) headers["x-amz-security-token"] = sessionToken;

  const signedNames = Object.keys(headers).sort();
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const { stringToSign } = await buildStringToSign({ method, url, headers, signedNames, payloadHash, amzDate, scope });
  const signature = await deriveSignature(secretAccessKey, dateStamp, region, service, stringToSign);
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedNames.join(";")}, Signature=${signature}`;
  headers.authorization = authorization;

  return { url: url.toString(), method, headers, authorization, amzDate, payloadHash };
}

/**
 * Builds a presigned URL (query auth) for a request.
 *
 * @param {{ method?: string, url: string | URL, region: string, service?: string, accessKeyId: string, secretAccessKey: string, sessionToken?: string | null, timestamp?: number | Date, expiresSeconds?: number, signedHeaders?: Array<string>, extraHeaders?: Record<string,string> }} input
 * @returns {Promise<{ url: string, amzDate: string, expires: number }>}
 */
export async function presignRequest(input) {
  const {
    region,
    service = "execute-api",
    accessKeyId,
    secretAccessKey,
    sessionToken = null,
    timestamp = Date.now(),
    expiresSeconds = 3600,
  } = input ?? {};
  if (!region || !accessKeyId || !secretAccessKey) {
    throw new TypeError("presignRequest requires region, accessKeyId and secretAccessKey.");
  }
  const expires = Number(expiresSeconds);
  if (!Number.isInteger(expires) || expires < 1 || expires > 7 * 24 * 3600) {
    throw new TypeError("presignRequest expiresSeconds must be 1–604800.");
  }
  const url = input.url instanceof URL ? new URL(input.url.toString()) : new URL(input.url);
  const method = String(input.method ?? "GET").toUpperCase();
  const amzDate = amzDateString(timestamp);
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const signedNames = [...(input.signedHeaders ?? ["host"])].map((entry) => String(entry).toLowerCase()).sort();
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Credential", `${accessKeyId}/${scope}`);
  url.searchParams.set("X-Amz-Date", amzDate);
  url.searchParams.set("X-Amz-Expires", String(expires));
  url.searchParams.set("X-Amz-SignedHeaders", signedNames.join(";"));
  if (sessionToken) url.searchParams.set("X-Amz-Security-Token", sessionToken);
  const headers = { host: url.host };
  for (const [name, value] of Object.entries(input.extraHeaders ?? {})) {
    const lower = String(name).toLowerCase();
    if (signedNames.includes(lower) && lower !== "host") headers[lower] = String(value).trim();
  }
  const { stringToSign } = await buildStringToSign({
    method, url, headers, signedNames, payloadHash: "UNSIGNED-PAYLOAD", amzDate, scope,
  });
  const signature = await deriveSignature(secretAccessKey, dateStamp, region, service, stringToSign);
  url.searchParams.set("X-Amz-Signature", signature);
  return { url: url.toString(), amzDate, expires };
}

// ---------------------------------------------------------------------------
// S07: consumer SigV4 verification (IAM equivalent).
// ---------------------------------------------------------------------------

function timingSafeEqualHex(a, b) {
  const left = String(a ?? "").toLowerCase();
  const right = String(b ?? "").toLowerCase();
  if (left.length !== right.length || left.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

function parseAuthorizationHeader(value) {
  const text = String(value ?? "");
  const match = text.match(/^AWS4-HMAC-SHA256\s+Credential=([^,]+),\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-fA-F]+)\s*$/);
  if (!match) return null;
  const [, credential, signedHeaders, signature] = match;
  const parts = credential.split("/");
  if (parts.length !== 5) return null;
  const [accessKeyId, dateStamp, credRegion, service, terminator] = parts;
  if (terminator !== "aws4_request") return null;
  return {
    accessKeyId,
    dateStamp,
    region: credRegion,
    service,
    signedHeaders: signedHeaders.split(";").map((entry) => entry.trim().toLowerCase()).filter(Boolean),
    signature,
  };
}

function parseAmzDate(value) {
  const text = String(value ?? "");
  const match = text.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

/**
 * Verifies a consumer SigV4-signed request.
 *
 * Supports header auth and presigned query auth. Returns the verified
 * identity on success; throws a `GatewayError`-shaped error
 * (`{ type, message }`) on failure so phases can render it directly.
 *
 * @param {Request} request - Incoming Web request.
 * @param {{ region?: string, lookupSecret?: (accessKeyId: string) => Promise<{ secretAccessKey: string, status?: string }|null>, now?: number, allowAnyRegion?: boolean }} [opts={}]
 * The gateway region defaults to `"auto"` (`PODS_REGION`); the authorize
 * phase passes `artifact.region`. It is an explicit parameter (never read
 * from `process.env` here) so the engine core stays free of Node-only APIs.
 * @returns {Promise<{ accessKeyId: string, region: string, signedHeaders: Array<string>, credential: object }>}
 */
export async function verifySignature(request, opts = {}) {
  const fail = (type, message) => {
    const error = new Error(message);
    error.type = type;
    throw error;
  };
  const mismatch = () => fail("INVALID_SIGNATURE", "The request signature we calculated does not match the signature you provided. Check your key and signing method.");
  const region = String(opts.region ?? "auto");
  const now = Number(opts.now ?? Date.now());
  const url = new URL(request.url);
  const params = url.searchParams;
  const lookupSecret = opts.lookupSecret ?? (async () => null);

  if (params.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256") {
    const header = request.headers.get("authorization");
    if (!header) fail("MISSING_AUTHENTICATION_TOKEN", "Missing Authentication Token");
    const parsed = parseAuthorizationHeader(header);
    if (!parsed || parsed.service !== "execute-api") mismatch();
    if (parsed.region !== region && !(opts.allowAnyRegion || parsed.region === "*")) mismatch();
    const amzDate = request.headers.get("x-amz-date");
    const requestTime = parseAmzDate(amzDate);
    if (requestTime === null) mismatch();
    // The credential scope date must equal the request date (AWS behavior).
    if (amzDate.slice(0, 8) !== parsed.dateStamp) mismatch();
    if (Math.abs(now - requestTime) > 5 * 60 * 1000) {
      fail("INVALID_SIGNATURE", `Signature expired: ${amzDate} is now earlier than ${amzDateString(now)} (plus 5 min skew).`);
    }
    const credential = await lookupSecret(parsed.accessKeyId);
    if (!credential || credential.status === "INACTIVE") {
      fail("INVALID_SIGNATURE", "The security token included in the request is invalid.");
    }
    const headers = {};
    for (const name of parsed.signedHeaders) {
      if (name === "host") {
        headers.host = url.host;
        continue;
      }
      const value = request.headers.get(name);
      if (value === null) mismatch();
      headers[name] = value.trim();
    }
    if (!parsed.signedHeaders.includes("host")) headers.host = url.host;
    const contentHash = request.headers.get("x-amz-content-sha256");
    let payloadHash;
    if (contentHash === "UNSIGNED-PAYLOAD") {
      payloadHash = "UNSIGNED-PAYLOAD";
    } else {
      const bodyBytes = new Uint8Array(await request.clone().arrayBuffer());
      payloadHash = await sha256Hex(bodyBytes);
    }
    const scope = `${parsed.dateStamp}/${parsed.region}/${parsed.service}/aws4_request`;
    if (!headers["x-amz-date"]) headers["x-amz-date"] = amzDate;
    const { stringToSign } = await buildStringToSign({
      method: String(request.method).toUpperCase(),
      url,
      headers,
      signedNames: parsed.signedHeaders.includes("host") ? parsed.signedHeaders : [...parsed.signedHeaders, "host"].sort(),
      payloadHash,
      amzDate,
      scope,
    });
    // Note: when the signer covered exactly the declared signed headers,
    // recomputation matches. Headers signed but since changed (or added
    // session-token handling) fall through to mismatch below.
    const expected = await deriveSignature(credential.secretAccessKey, parsed.dateStamp, parsed.region, parsed.service, stringToSign);
    if (!timingSafeEqualHex(expected, parsed.signature)) mismatch();
    return { accessKeyId: parsed.accessKeyId, region: parsed.region, signedHeaders: parsed.signedHeaders, credential };
  }

  // Presigned query auth.
  const credentialParam = params.get("X-Amz-Credential") ?? "";
  const signedHeaders = (params.get("X-Amz-SignedHeaders") ?? "").split(";").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const signature = params.get("X-Amz-Signature") ?? "";
  const amzDate = params.get("X-Amz-Date") ?? "";
  const expires = Number(params.get("X-Amz-Expires") ?? "NaN");
  const parts = credentialParam.split("/");
  if (parts.length !== 5 || parts[4] !== "aws4_request") mismatch();
  const [accessKeyId, dateStamp, credRegion, service] = parts;
  if (!Number.isInteger(expires) || expires < 1 || expires > 7 * 24 * 3600) mismatch();
  const requestTime = parseAmzDate(amzDate);
  if (requestTime === null) mismatch();
  if (amzDate.slice(0, 8) !== dateStamp) mismatch();
  if (now > requestTime + expires * 1000) fail("EXPIRED_TOKEN", "Token expired.");
  // A presigned date more than 5 min in the future is a skew failure, not an expiry.
  if (requestTime - now > 5 * 60 * 1000) {
    fail("INVALID_SIGNATURE", `Signature expired: ${amzDate} is now earlier than ${amzDateString(now)} (plus 5 min skew).`);
  }
  if (service !== "execute-api") mismatch();
  if (credRegion !== region && !(opts.allowAnyRegion || credRegion === "*")) mismatch();
  const resolved = await lookupSecret(accessKeyId);
  if (!resolved || resolved.status === "INACTIVE") {
    fail("INVALID_SIGNATURE", "The security token included in the request is invalid.");
  }
  const unsigned = new URL(request.url);
  unsigned.searchParams.delete("X-Amz-Signature");
  const headers = { host: unsigned.host };
  for (const name of signedHeaders) {
    if (name === "host") continue;
    const value = request.headers.get(name);
    if (value === null) mismatch();
    headers[name] = value.trim();
  }
  const scope = `${dateStamp}/${credRegion}/${service}/aws4_request`;
  const { stringToSign } = await buildStringToSign({
    method: String(request.method).toUpperCase(),
    url: unsigned,
    headers,
    signedNames: signedHeaders,
    payloadHash: "UNSIGNED-PAYLOAD",
    amzDate,
    scope,
  });
  const expected = await deriveSignature(resolved.secretAccessKey, dateStamp, credRegion, service, stringToSign);
  if (!timingSafeEqualHex(expected, signature)) mismatch();
  return { accessKeyId, region: credRegion, signedHeaders, credential: resolved };
}
