/**
 * Ordered phase registry (the pipeline's fixed order, §3).
 *
 * Each spec adds one line here for its phase module. The order below is
 * fixed by the architecture spec and must not be reordered. Each entry
 * is a module exporting `name` and `run(ctx)`; later specs replace a
 * stub's body while keeping that contract.
 *
 * Rows 8 and 10 are the pre-auth and post-auth passes of the resource
 * policy, hence the two `resourcePolicy:*` entries.
 *
 * @module lib/gateway/core/phases/index
 */

import * as receive from "./receive.mjs";
import * as resolveEndpoint from "./resolve-endpoint.mjs";
import * as endpointAccess from "./endpoint-access.mjs";
import * as waf from "./waf.mjs";
import * as match from "./match.mjs";
import * as cors from "./cors.mjs";
import * as canary from "./canary.mjs";
import * as resourcePolicyPre from "./resource-policy-pre.mjs";
import * as authorize from "./authorize.mjs";
import * as resourcePolicyPost from "./resource-policy-post.mjs";
import * as apiKey from "./api-key.mjs";
import * as throttle from "./throttle.mjs";
import * as quota from "./quota.mjs";
import * as validate from "./validate.mjs";
import * as cacheLookup from "./cache-lookup.mjs";
import * as integrationRequest from "./integration-request.mjs";
import * as invoke from "./invoke.mjs";
import * as integrationResponse from "./integration-response.mjs";
import * as methodResponse from "./method-response.mjs";
import * as emit from "./emit.mjs";

/**
 * Phases in pipeline order. Each entry is `{ name, run }` where `run`
 * is `async (ctx) => void | Response`.
 * @type {Array<{ name: string, run: (ctx: object) => Promise<Response | void> }>}
 */
export const PHASES = [
  receive,
  resolveEndpoint,
  endpointAccess,
  waf,
  match,
  cors,
  canary,
  resourcePolicyPre,
  authorize,
  resourcePolicyPost,
  apiKey,
  throttle,
  quota,
  validate,
  cacheLookup,
  integrationRequest,
  invoke,
  integrationResponse,
  methodResponse,
  emit,
];

/** Phase names in pipeline order. */
export const PHASE_ORDER = PHASES.map((phase) => phase.name);
