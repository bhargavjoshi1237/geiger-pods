/**
 * Pure UI helpers for the S07 authorization screens (C1).
 *
 * Kept in a JSX-free module so `node --test` can cover the JWT debugger and
 * the policy JSON validation without a browser. All functions are total and
 * never touch the network.
 *
 * @module lib/workspace/auth-ui
 */

/**
 * Decodes a JWT without verifying its signature (debugger only).
 *
 * @param {string} token - The pasted `header.payload[.signature]` token.
 * @returns {{ header: object, payload: object }} Decoded header and claims.
 * @throws {Error} When the token is not shaped like a JWT.
 */
export function decodeJwtPayload(token) {
  const cleaned = String(token ?? "").trim().replace(/^Bearer\s+/i, "");
  const parts = cleaned.split(".");
  if (parts.length < 2 || parts.length > 3) {
    throw new Error("Expected header.payload[.signature] with base64url segments.");
  }
  return { header: decodeSegment(parts[0], "header"), payload: decodeSegment(parts[1], "payload") };
}

/**
 * Decodes one base64url JSON segment.
 *
 * @param {string} segment - A single JWT segment.
 * @param {string} name - Segment name for error messages.
 * @returns {object} Parsed JSON object.
 * @throws {Error} When the segment is not base64url JSON.
 */
function decodeSegment(segment, name) {
  let parsed;
  try {
    const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(padded, "base64").toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`JWT ${name} is not base64url-encoded JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`JWT ${name} must be a JSON object.`);
  }
  return parsed;
}

/**
 * Parses and lightly validates an identity/resource policy document pasted
 * into the JSON editors. Structural validation stays server-side (the control
 * plane returns per-path errors); this only guards against non-JSON and
 * non-object input plus the 8192-char resource-policy budget.
 *
 * @param {string} text - Raw editor text.
 * @param {{ maxChars?: number }} [options] - Size budget override.
 * @returns {{ document: object }} The parsed document.
 * @throws {Error} When the text is not a JSON object or exceeds the budget.
 */
export function validatePolicyJson(text, options = {}) {
  const maxChars = options.maxChars ?? 8192;
  let document;
  try {
    document = JSON.parse(String(text ?? ""));
  } catch {
    throw new Error("Policy must be valid JSON.");
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("Policy must be a JSON object with Version and Statement.");
  }
  if (JSON.stringify(document).length > maxChars) {
    throw new Error(`Policy must serialize to at most ${maxChars} characters.`);
  }
  return { document };
}

/**
 * Example identity sources per authorizer type and API protocol, matching the
 * engine grammar (`validate-authorization.mjs`): REST TOKEN takes exactly one
 * header expression; REQUEST/HTTP accept `$request.*`, `$stageVariables.*`,
 * `$context.*` (and `method.request.*` on REST).
 *
 * @param {string} type - `JWT`, `TOKEN` or `REQUEST`.
 * @param {string} protocol - `REST`, `HTTP` or `WEBSOCKET`.
 * @returns {Array<string>} Suggested identity source expressions.
 */
export function identitySourceExamples(type, protocol) {
  if (type === "JWT") {
    return protocol === "REST"
      ? ["method.request.header.Authorization"]
      : ["$request.header.Authorization"];
  }
  if (type === "TOKEN") {
    return protocol === "REST"
      ? ["method.request.header.Authorization"]
      : ["$request.header.Authorization", "$request.querystring.token"];
  }
  return protocol === "REST"
    ? ["method.request.header.Authorization", "method.request.querystring.version", "context.identity.sourceIp"]
    : ["$request.header.Authorization", "$request.querystring.version", "$stageVariables.phase", "$context.identity.sourceIp"];
}

/**
 * Authorizer types creatable for an API protocol (capability matrix,
 * `capabilities.mjs`): JWT needs `auth.jwt` (REST/HTTP), TOKEN/REQUEST need
 * `auth.custom` (all three; WebSocket only guards `$connect`).
 *
 * @param {string} protocol - `REST`, `HTTP` or `WEBSOCKET`.
 * @returns {Array<"JWT" | "TOKEN" | "REQUEST">} Creatable types.
 */
export function authorizerTypesFor(protocol) {
  if (protocol === "REST" || protocol === "HTTP") return ["JWT", "TOKEN", "REQUEST"];
  if (protocol === "WEBSOCKET") return ["TOKEN", "REQUEST"];
  return [];
}
