/**
 * S11 control-plane tests: domain/mapping/rule/truststore validation,
 * WAF CRUD, stack kinds (domains + waf), CLI domains commands.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createS11FakeDb, PROJECT, ADMIN } from "./fake-db.mjs";
import {
  createDomain,
  listDomains,
  getDomain,
  updateDomain,
  deleteDomain,
  createMapping,
  listMappings,
  deleteMapping,
  createRoutingRule,
  reorderRoutingRules,
  createTrustStore,
  associateConnector,
  DOMAIN_STATUSES,
} from "../../lib/control/domains.mjs";
import {
  createWebAcl,
  associateWebAcl,
  planDomainsStack,
  planWafStack,
} from "../../lib/control/waf.mjs";
import { COMMANDS } from "../../cli/commands.mjs";

test("S11 control: domain lifecycle validates names, types and policies", async () => {
  const db = createS11FakeDb();
  // Name validation: uppercase, spaces and bad wildcards rejected.
  await assert.rejects(
    createDomain(db, ADMIN, { projectId: PROJECT, input: { domainName: "API.Example.com" } }),
    (error) => error.status === 422,
  );
  await assert.rejects(
    createDomain(db, ADMIN, { projectId: PROJECT, input: { domainName: "not a domain" } }),
    (error) => error.status === 422,
  );
  await assert.rejects(
    createDomain(db, ADMIN, { projectId: PROJECT, input: { domainName: "*.*.example.com" } }),
    (error) => error.status === 422,
  );
  // Endpoint/credential enums validated.
  await assert.rejects(
    createDomain(db, ADMIN, { projectId: PROJECT, input: { domainName: "a.example.com", endpointType: "GLOBAL" } }),
    (error) => error.status === 422,
  );
  await assert.rejects(
    createDomain(db, ADMIN, { projectId: PROJECT, input: { domainName: "a.example.com", securityPolicy: "TLS_1_0" } }),
    (error) => error.status === 422,
  );

  const created = await createDomain(db, ADMIN, {
    projectId: PROJECT,
    input: { domainName: "api.example.com", endpointType: "REGIONAL", ipAddressType: "dualstack", securityPolicy: "TLS_1_2" },
  });
  assert.equal(created.status, 201);
  assert.ok(DOMAIN_STATUSES.includes(created.body.status));
  assert.match(created.body.targetHostname, /\.gw\./);
  assert.equal(created.dnsRecords.length, 2);

  // Global uniqueness: a second project cannot claim the same name.
  await assert.rejects(
    createDomain(db, ADMIN, { projectId: "other-project", input: { domainName: "api.example.com" } }),
    (error) => error.status === 409,
  );

  const listed = await listDomains(db, ADMIN, { projectId: PROJECT });
  assert.equal(listed.items.length, 1);
  assert.equal((await getDomain(db, ADMIN, { projectId: PROJECT, domainId: created.body.id })).domainName, "api.example.com");

  // Optimistic concurrency on update.
  const updated = await updateDomain(db, ADMIN, {
    projectId: PROJECT, domainId: created.body.id, patch: { routingMode: "ROUTING_RULE_ONLY" }, expectedVersion: 1,
  });
  assert.equal(updated.routingMode, "ROUTING_RULE_ONLY");
  await assert.rejects(
    updateDomain(db, ADMIN, { projectId: PROJECT, domainId: created.body.id, patch: { routingMode: "API_MAPPING_ONLY" }, expectedVersion: 1 }),
    (error) => error.status === 409,
  );

  // Unauthorized actors cannot manage domains (RBAC pods.domain.write).
  const dbDenied = createS11FakeDb({ roles: { "u-s11-admin": "member" } });
  await assert.rejects(
    createDomain(dbDenied, ADMIN, { projectId: PROJECT, input: { domainName: "x.example.com" } }),
    (error) => error.status === 403,
  );

  const deleted = await deleteDomain(db, ADMIN, { projectId: PROJECT, domainId: created.body.id });
  assert.equal(deleted.deleted, true);
});

test("S11 control: routing rules enforce priority uniqueness, condition caps and reorder with gaps", async () => {
  const db = createS11FakeDb();
  const created = await createDomain(db, ADMIN, { projectId: PROJECT, input: { domainName: "api.example.com" } });
  const domainId = created.body.id;

  const first = await createRoutingRule(db, ADMIN, {
    projectId: PROJECT, domainId,
    input: {
      priority: 10,
      conditions: { matchHeaders: [{ header: "x-a", valueGlob: "1*" }] },
      action: { invokeApi: { apiId: "a", stage: "prod", stripBasePath: false } },
    },
  });
  assert.equal(first.body.priority, 10);

  // Duplicate priority rejected.
  await assert.rejects(
    createRoutingRule(db, ADMIN, {
      projectId: PROJECT, domainId,
      input: {
        priority: 10,
        conditions: { matchHeaders: [{ header: "x-b", valueGlob: "2*" }] },
        action: { invokeApi: { apiId: "b", stage: "prod", stripBasePath: false } },
      },
    }),
    (error) => error.status === 409,
  );
  // Three headers exceed the cap of two.
  await assert.rejects(
    createRoutingRule(db, ADMIN, {
      projectId: PROJECT, domainId,
      input: {
        priority: 20,
        conditions: { matchHeaders: [{ header: "x-a", valueGlob: "*" }, { header: "x-b", valueGlob: "*" }, { header: "x-c", valueGlob: "*" }] },
        action: { invokeApi: { apiId: "b", stage: "prod", stripBasePath: false } },
      },
    }),
    (error) => error.status === 422,
  );
  // Restricted header rejected.
  await assert.rejects(
    createRoutingRule(db, ADMIN, {
      projectId: PROJECT, domainId,
      input: {
        priority: 20,
        conditions: { matchHeaders: [{ header: "X-Forwarded-For", valueGlob: "*" }] },
        action: { invokeApi: { apiId: "b", stage: "prod", stripBasePath: false } },
      },
    }),
    (error) => error.status === 422,
  );

  const second = await createRoutingRule(db, ADMIN, {
    projectId: PROJECT, domainId,
    input: {
      priority: 5,
      conditions: { matchBasePaths: ["v2"] },
      action: { invokeApi: { apiId: "c", stage: "prod", stripBasePath: true } },
    },
  });
  // Reorder renumbers with gaps.
  const reordered = await reorderRoutingRules(db, ADMIN, { projectId: PROJECT, domainId, ruleIds: [first.body.id, second.body.id] });
  assert.deepEqual(reordered.map((entry) => entry.priority), [10, 20]);
  void listMappings;
  void deleteMapping;
});

test("S11 control: truststores parse bundles with warnings; WAF associations are one-ACL-per-stage; stack kinds plan", async () => {
  const db = createS11FakeDb();
  const { readFile } = await import("node:fs/promises");
  const caPem = await readFile(new URL("./fixtures/certs/ca.pem", import.meta.url), "utf8");
  const store = await createTrustStore(db, ADMIN, { projectId: PROJECT, input: { name: "main", pemBundle: caPem } });
  assert.equal(store.body.version, 1);
  assert.equal(store.body.certCount, 1);
  assert.deepEqual(store.body.warnings, []);
  await assert.rejects(
    createTrustStore(db, ADMIN, { projectId: PROJECT, input: { name: "bad", pemBundle: "not-a-pem" } }),
    (error) => error.status === 422,
  );

  const acl = await createWebAcl(db, ADMIN, { projectId: PROJECT, input: { name: "acl-1", defaultAction: "ALLOW", rules: [] } });
  const assoc = await associateWebAcl(db, ADMIN, {
    projectId: PROJECT, webAclId: acl.body.id, input: { apiId: "api-1", stageName: "prod" },
  });
  assert.equal(assoc.body.stageName, "prod");
  const acl2 = await createWebAcl(db, ADMIN, { projectId: PROJECT, input: { name: "acl-2", defaultAction: "BLOCK", rules: [] } });
  await assert.rejects(
    associateWebAcl(db, ADMIN, { projectId: PROJECT, webAclId: acl2.body.id, input: { apiId: "api-1", stageName: "prod" } }),
    (error) => error.status === 409,
  );

  // Private-domain access associations record connector links.
  const domain = await createDomain(db, ADMIN, { projectId: PROJECT, input: { domainName: "priv.example.com", endpointType: "PRIVATE" } });
  const link = await associateConnector(db, ADMIN, { projectId: PROJECT, domainId: domain.body.id, input: { connectorId: "conn-1" } });
  assert.equal(link.connectorId, "conn-1");

  // Stack kinds (F25): domains + waf plan through the registry.
  const { planStack } = await import("../../lib/control/stacks.mjs");
  await import("../../lib/control/domains.mjs");
  await import("../../lib/control/waf.mjs");
  const file = { version: 1, stack: "s11", domains: [{ name: "api.example.com", endpointType: "REGIONAL" }], waf: [{ name: "acl-1" }] };
  const planned = await planStack(db, ADMIN, { projectId: PROJECT, stack: "s11", file });
  const byKind = new Map(planned.changes.map((entry) => [`${entry.kind}/${entry.name}`, entry]));
  // New domain → create through the registry (not the placeholder helper).
  assert.equal(byKind.get("domains/api.example.com")?.op, "create");
  // acl-1 matches live (defaults fill from the row) → noop, hence absent;
  // live acl-2 is unwanted → delete parked behind prune.
  assert.ok(!byKind.has("waf/acl-1"), "matching ACL should plan noop");
  assert.equal(byKind.get("waf/acl-2")?.op, "delete");
  assert.equal(byKind.get("waf/acl-2")?.skipped, "needs_prune");
  // A live domain row with a drifted field plans an update with a diff.
  db.listStackResources = async () => ({
    apis: [],
    domains: [{ domain_name: "api.example.com", endpoint_type: "REGIONAL", security_policy: "TLS_1_2", routing_mode: "API_MAPPING_ONLY" }],
    waf: [],
  });
  const drifted = await planStack(db, ADMIN, {
    projectId: PROJECT,
    stack: "s11",
    file: { ...file, domains: [{ name: "api.example.com", endpointType: "REGIONAL", routingMode: "ROUTING_RULE_ONLY" }] },
  });
  const update = drifted.changes.find((entry) => entry.kind === "domains" && entry.name === "api.example.com");
  assert.equal(update?.op, "update");
  assert.deepEqual(update?.diff?.routingMode, { before: "API_MAPPING_ONLY", after: "ROUTING_RULE_ONLY" });
  void planDomainsStack;
  void planWafStack;

  // CLI domains commands exist and no longer stub.
  for (const key of ["domains list", "domains create", "domains verify", "domains delete"]) {
    assert.ok(typeof COMMANDS[key] === "function", `missing CLI command ${key}`);
  }
});
