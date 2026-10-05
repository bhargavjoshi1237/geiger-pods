/**
 * `validate` phase (pipeline row 14 — request validator: params, body).
 *
 * S06W implementation (replaces the S01 no-op stub, keeping the `name` +
 * `run(ctx)` contract). REST only (capability `validation` is REST +
 * WEBSOCKET; WEBSOCKET is S12-owned and skipped here; HTTP APIs have no
 * request validators).
 *
 * Order per spec §§4+8:
 * 1. Cache the raw body (`readRequestBody`) for downstream phases.
 * 2. When `minimum_compression_size` is set, decompress `Content-Encoding:
 *    gzip|deflate` bodies *before* validation. Unknown encodings → 415
 *    `UNSUPPORTED_MEDIA_TYPE`; corrupt payloads → 400 `BAD_REQUEST_BODY`.
 *    Proxy integrations still receive the original encoded bytes (see
 *    `integrationRequest`, which uses `ctx.rawBody` for proxies).
 * 3. Resolve the method's validator (`method.validatorId`, else the API
 *    default `artifact.defaultValidatorId`). None → no validation.
 * 4. `validateRequest`: required `method.request.*` params → 400
 *    `BAD_REQUEST_PARAMETERS`; body model (by Content-Type, `$default`
 *    fallback, draft-04) → 400 `BAD_REQUEST_BODY` with AWS-style
 *    `$context.error.validationErrorString`.
 *
 * Errors are thrown as `GatewayError`; the pipeline renderer applies
 * gateway-response customization, managed CORS and `$context.error.*`.
 *
 * @module lib/gateway/core/phases/validate
 */

import { GatewayError } from "../errors.mjs";
import { decompressRequestBody } from "../processing/compression.mjs";
import {
  gatewayErrorResponse,
  readRequestBody,
  snapshotMethodRequest,
  validatorsFor,
} from "../processing/runtime.mjs";
import { validateRequest } from "../processing/validation.mjs";

/** Phase name as listed in the pipeline table (§3). */
export const name = "validate";

/**
 * Finds a validator entry by id or name in `artifact.validators`.
 *
 * @param {object} artifact
 * @param {string|null} validatorId
 * @returns {{ entry: object, validateBody: boolean, validateParameters: boolean }|null}
 */
function findValidator(artifact, validatorId) {
  if (!validatorId) return null;
  const table = artifact?.validators ?? {};
  const direct = table[validatorId] ?? table[String(validatorId)] ?? null;
  const entry = direct
    ?? Object.values(table).find(
      (candidate) => candidate?.name === validatorId || candidate?.id === validatorId,
    )
    ?? null;
  if (!entry) return null;
  return {
    entry,
    validateBody: entry.validate_request_body ?? entry.validateRequestBody ?? true,
    validateParameters:
      entry.validate_request_parameters ?? entry.validateRequestParameters ?? false,
  };
}

/**
 * Validates the request parameters and body.
 *
 * @param {object} ctx - Pipeline context.
 * @returns {Promise<Response|undefined>} Customized error response, or
 *   `undefined` when the request is valid (or unvalidated).
 */
export async function run(ctx) {
  const artifact = ctx?.artifact ?? {};
  const raw = await readRequestBody(ctx);
  snapshotMethodRequest(ctx);

  // Decompress before validation whenever compression is configured —
  // even with no validator (AWS decompresses unconditionally).
  let working = raw;
  const threshold = artifact.settings?.minimumCompressionSize ?? null;
  let contentEncoding = null;
  try {
    contentEncoding = ctx.request.headers.get("content-encoding");
  } catch {
    contentEncoding = null;
  }
  if ((threshold !== null && threshold !== undefined) && contentEncoding) {
    try {
      working = decompressRequestBody({ body: raw, contentEncoding });
    } catch (error) {
      if (error instanceof GatewayError) return gatewayErrorResponse(ctx, error);
      throw error;
    }
  }
  ctx.decodedBody = working;

  if ((artifact.protocol ?? "REST") !== "REST") return undefined;
  const methodId = ctx?.match?.methodId ?? null;
  if (!methodId) return undefined;
  let method = null;
  for (const resource of artifact.resources ?? []) {
    for (const entry of Object.values(resource?.methods ?? {})) {
      if (String(entry?.id) === String(methodId)) method = entry;
    }
  }
  if (!method) return undefined;

  const validatorId = method.validatorId ?? method.requestValidatorId
    ?? artifact.defaultValidatorId ?? null;
  const validator = findValidator(artifact, validatorId);
  if (!validator) return undefined;

  let contentType = null;
  try {
    contentType = ctx.request.headers.get("content-type");
  } catch {
    contentType = null;
  }
  let bodyText = "";
  try {
    bodyText = Buffer.from(working).toString("utf8");
  } catch {
    bodyText = "";
  }
  try {
    validateRequest({
      requiredParams: method.requestParameters ?? {},
      requestModels: method.requestModels ?? {},
      contentType,
      bodyText,
      validators: validatorsFor(artifact),
      validateBody: validator.validateBody,
      validateParameters: validator.validateParameters,
      actualParams: ctx.methodRequest,
    });
  } catch (error) {
    if (error instanceof GatewayError) return gatewayErrorResponse(ctx, error);
    throw error;
  }
  return undefined;
}
