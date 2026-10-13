// Web application firewall (IP/regex sets, managed rule groups, rate-based
// rules, stage associations) and request-signing credentials for partners.

import {
  associateWebAcl, createIpSet, createRegexSet, createWebAcl, listIpSets, listRegexSets, listWebAcls,
} from "../../../lib/control/waf.mjs";
import {
  createSigningCredential, createSigningPolicy, listSigningCredentials, listSigningPolicies,
} from "../../../lib/control/signing-credentials.mjs";
import { body, items } from "../context.mjs";

export async function seedSecurity(ctx, state) {
  const { db, actor, projectId, log } = ctx;
  log.section("Web application firewall");

  const ipSets = items(await listIpSets(db, actor, { projectId }));
  const ensureIpSet = async (name, addresses) => {
    const found = ipSets.find((row) => row.name === name);
    if (found) return found;
    const created = body(await createIpSet(db, actor, { projectId, input: { name, ipVersion: "IPV4", addresses } }));
    log.item(`+ IP set ${name} (${addresses.length})`);
    return created;
  };
  const scrapers = await ensureIpSet("known-scrapers", ["203.0.113.0/24", "198.51.100.66/32", "192.0.2.0/28"]);
  const office = await ensureIpSet("geiger-offices", ["100.64.10.0/24", "100.64.20.0/24"]);

  const regexSets = items(await listRegexSets(db, actor, { projectId }));
  let agents = regexSets.find((row) => row.name === "scraper-user-agents");
  if (!agents) {
    agents = body(await createRegexSet(db, actor, {
      projectId, input: { name: "scraper-user-agents", patterns: ["python-requests", "scrapy", "headlesschrome", "go-http-client/1\\.1"] },
    }));
    log.item("+ regex set scraper-user-agents");
  }

  const acls = items(await listWebAcls(db, actor, { projectId }));
  let shield = acls.find((row) => row.name === "anilist-edge-shield");
  if (!shield) {
    shield = body(await createWebAcl(db, actor, {
      projectId,
      input: {
        name: "anilist-edge-shield",
        defaultAction: "ALLOW",
        customResponses: {
          "blocked-json": { statusCode: 403, contentType: "application/json", body: "{\"error\":{\"code\":\"BLOCKED\",\"message\":\"Blocked by AniList Edge Shield.\"}}" },
          "slow-down": { statusCode: 429, contentType: "application/json", body: "{\"error\":{\"code\":\"SLOW_DOWN\",\"message\":\"Too many requests from your IP.\"}}" },
        },
        rules: [
          { name: "allow-geiger-offices", priority: 0, action: "ALLOW", statement: { type: "IPSetReferenceStatement", ipSetId: office.id } },
          { name: "block-known-scrapers", priority: 1, action: "BLOCK", customResponseKey: "blocked-json", statement: { type: "IPSetReferenceStatement", ipSetId: scrapers.id } },
          {
            name: "block-scraper-user-agents", priority: 2, action: "BLOCK", customResponseKey: "blocked-json",
            statement: { type: "RegexPatternSetReferenceStatement", regexSetId: agents.id, fieldToMatch: { SingleHeader: { name: "user-agent" } }, textTransformations: ["LOWERCASE"] },
          },
          {
            name: "per-ip-rate-limit", priority: 3, action: "BLOCK", customResponseKey: "slow-down",
            statement: { type: "RateBasedStatement", limit: 300, evaluationWindowSec: 300, aggregateKeyType: "IP" },
          },
          {
            name: "graphql-body-size", priority: 4, action: "BLOCK",
            statement: {
              type: "AndStatement",
              statements: [
                { type: "ByteMatchStatement", searchString: "/graphql", positionalConstraint: "STARTS_WITH", fieldToMatch: { UriPath: {} }, textTransformations: ["LOWERCASE"] },
                { type: "SizeConstraintStatement", fieldToMatch: { Body: {} }, comparisonOperator: "GT", size: 8192 },
              ],
            },
          },
          { name: "managed-common", priority: 10, action: "BLOCK", overrideAction: "NONE", statement: { type: "ManagedRuleGroupStatement", name: "PodsCommonRuleSet" } },
          { name: "managed-sqli", priority: 11, action: "BLOCK", overrideAction: "NONE", statement: { type: "ManagedRuleGroupStatement", name: "PodsSQLiRuleSet" } },
          { name: "managed-bad-inputs", priority: 12, action: "BLOCK", overrideAction: "NONE", statement: { type: "ManagedRuleGroupStatement", name: "PodsKnownBadInputsRuleSet" } },
          { name: "managed-admin-protection", priority: 13, action: "BLOCK", overrideAction: "COUNT", statement: { type: "ManagedRuleGroupStatement", name: "PodsAdminProtectionRuleSet" } },
        ],
        visibility: { sampledRequests: true, metrics: true },
      },
    }));
    log.item("+ web ACL anilist-edge-shield (9 rules, 4 managed groups)");
  }

  let lockdown = acls.find((row) => row.name === "staging-office-only");
  if (!lockdown) {
    lockdown = body(await createWebAcl(db, actor, {
      projectId,
      input: {
        name: "staging-office-only",
        defaultAction: "BLOCK",
        rules: [
          { name: "allow-geiger-offices", priority: 0, action: "ALLOW", statement: { type: "IPSetReferenceStatement", ipSetId: office.id } },
          {
            name: "allow-qa-header", priority: 1, action: "ALLOW",
            statement: { type: "ByteMatchStatement", searchString: "qa-smoke", positionalConstraint: "EXACTLY", fieldToMatch: { SingleHeader: { name: "x-qa-run" } }, textTransformations: ["NONE"] },
          },
        ],
      },
    }));
    log.item("+ web ACL staging-office-only (default BLOCK)");
  }

  for (const [acl, apiId, stageName] of [[shield, state.rest.apiId, "prod"], [shield, state.http.apiId, "$default"], [lockdown, state.rest.apiId, "staging"]]) {
    try {
      await associateWebAcl(db, actor, { projectId, webAclId: acl.id, input: { apiId, stageName } });
      log.item(`  ↔ ${acl.name} → ${stageName}`);
    } catch (error) {
      if (error?.status !== 409) throw error;
    }
  }
  state.waf = { shield: shield.id, lockdown: lockdown.id };

  log.section("Signing credentials");
  const creds = items(await listSigningCredentials(db, actor, { projectId, limit: 100 }));
  const arn = (stage, method, path) => `arn:pods:execute-api:ap-south-1:${projectId}:${state.rest.publicId}/${stage}/${method}/${path}`;
  const credentials = [
    {
      name: "crunchy-recs-batch",
      tags: { partner: "crunchy-recs" },
      policies: [{
        name: "read-catalog",
        document: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "execute-api:Invoke", Resource: arn("prod", "GET", "*") }] },
      }, {
        name: "exports-from-partner-network",
        document: {
          Version: "2012-10-17",
          Statement: [{
            Effect: "Allow", Action: "execute-api:Invoke", Resource: arn("prod", "POST", "partners/exports"),
            Condition: { IpAddress: { "aws:SourceIp": ["100.72.0.0/16"] }, Bool: { "aws:SecureTransport": "true" } },
          }],
        },
      }],
    },
    {
      name: "ci-smoke-tests",
      tags: { owner: "platform" },
      policies: [{
        name: "staging-and-dev-only",
        document: {
          Version: "2012-10-17",
          Statement: [
            { Effect: "Allow", Action: "execute-api:*", Resource: arn("staging", "*", "*") },
            { Effect: "Allow", Action: "execute-api:*", Resource: arn("dev", "*", "*") },
            { Effect: "Deny", Action: "execute-api:*", Resource: arn("prod", "*", "*") },
          ],
        },
      }],
    },
  ];
  state.signing = {};
  for (const spec of credentials) {
    let credential = creds.find((row) => row.name === spec.name);
    if (!credential) {
      credential = body(await createSigningCredential(db, actor, { projectId, name: spec.name, tags: spec.tags }));
      log.item(`+ signing credential ${spec.name} (${credential.accessKeyId})`);
    } else {
      log.skip(`signing credential ${spec.name}`);
    }
    const policies = items(await listSigningPolicies(db, actor, { projectId, credentialId: credential.id }));
    for (const policy of spec.policies) {
      if (policies.some((row) => row.name === policy.name)) continue;
      await createSigningPolicy(db, actor, { projectId, credentialId: credential.id, name: policy.name, document: policy.document });
      log.item(`  + policy ${policy.name}`);
    }
    state.signing[spec.name] = credential.id;
  }
}
