// Authorizers (JWT / custom) referenced by catalog.js AUTHORIZER_REFS. Rows mirror supabase/migrations/auth (pods.authorizers).
// Methods/routes say CUSTOM; the authorizer row is TOKEN (REST, one bearer
// header) or REQUEST (several identity sources).

import { PROJECT_ID, daysAgo, sid } from "./helpers.js";
import { personId } from "../cast.js";
import { API_SPECS, AUTHORIZER_REFS, apiId } from "./catalog.js";

const DETAILS = {
  "kestrel-customers": {
    identity_source: ["$request.header.Authorization"],
    jwt: { issuer: "https://auth.kestrelbikes.example/", audience: ["aero-preorders", "kestrel-app"] },
    result_ttl_seconds: 0,
    created: 40,
    owner: 9,
  },
  "dealer-portal": {
    type: "TOKEN",
    identity_source: ["method.request.header.Authorization"],
    identity_validation_expression: "^Bearer [-0-9A-Za-z._~+/]+=*$",
    function: { provider: "webhook", url: "https://dealers.kestrelbikes.example/pods/authorize" },
    payload_format_version: "1.0",
    result_ttl_seconds: 300,
    created: 290,
    owner: 9,
  },
  "halcyon-sso": {
    identity_source: ["method.request.header.Authorization"],
    jwt: { issuer: "https://sso.halcyon.studio/", audience: ["studio-ops"] },
    result_ttl_seconds: 300,
    created: 250,
    owner: 2,
  },
  "atlas-staff": {
    type: "REQUEST",
    identity_source: ["method.request.header.X-Atlas-Staff", "method.request.querystring.store"],
    function: { provider: "aws_lambda", functionArn: "arn:aws:lambda:eu-west-1:210987654321:function:atlas-staff-authorizer" },
    payload_format_version: "1.0",
    result_ttl_seconds: 120,
    timeout_ms: 5000,
    created: 180,
    owner: 5,
  },
};

export function authorizersSeed() {
  const authorizers = AUTHORIZER_REFS.map((ref) => {
    const { created, owner, type, ...detail } = DETAILS[ref.name];
    const api = API_SPECS.find((spec) => spec.n === ref.api);
    return {
      id: sid("authorizer", ref.n),
      project_id: PROJECT_ID,
      api_id: apiId(ref.api),
      public_id: `au${ref.n}${api.publicId.slice(0, 5)}`,
      name: ref.name,
      type: type ?? ref.type,
      identity_source: [],
      identity_validation_expression: null,
      jwt: null,
      function: null,
      payload_format_version: null,
      enable_simple_responses: false,
      result_ttl_seconds: 300,
      timeout_ms: 10000,
      credentials_ref: null,
      ...detail,
      created_by: personId(owner),
      created_at: daysAgo(created),
      updated_at: daysAgo(Math.max(1, Math.floor(created / 6))),
      version: 1 + (ref.n % 3),
    };
  });
  return { authorizers };
}
