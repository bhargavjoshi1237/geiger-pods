// Connectors (private integrations), backend client certificates, mTLS trust
// stores, custom domains with API mappings and routing rules.

import { createConnector, createConnectorToken, listConnectorTokens, listConnectors } from "../../../lib/control/connectors.mjs";
import { generateClientCertificate, listClientCertificates } from "../../../lib/control/client-certificates.mjs";
import {
  associateConnector, createDomain, createMapping, createRoutingRule, createTrustStore, importCertificate,
  listDomains, listMappings, listRoutingRules, listTrustStores, updateDomain, verifyDomain,
} from "../../../lib/control/domains.mjs";
import { issueSelfSignedCertificate } from "../../../lib/control/cert-issue.mjs";
import { body, items } from "../context.mjs";

const CONNECTORS = [
  {
    key: "recs",
    name: "recs-engine-mumbai",
    description: "Pods Connector agent in the Mumbai office rack: reaches the on-prem recommendation engine (recs.geiger.internal) without opening inbound ports.",
    allowedTargets: ["recs.geiger.internal:8080", "10.20.0.0/16:8080"],
    tokens: 2,
  },
  {
    key: "archive",
    name: "media-archive-vpc",
    description: "Agent inside the media-archive VPC for cover-art mirroring jobs.",
    allowedTargets: ["archive.geiger.internal:443"],
    tokens: 1,
  },
];

export async function seedConnectors(ctx, state) {
  const { db, actor, projectId, log } = ctx;
  log.section("Connectors & certificates");
  const existing = items(await listConnectors(db, actor, { projectId, limit: 100 }));
  state.connectors = {};
  for (const spec of CONNECTORS) {
    let connector = existing.find((row) => row.name === spec.name);
    if (connector) {
      log.skip(`connector ${spec.name}`);
    } else {
      connector = body(await createConnector(db, actor, {
        projectId, input: { name: spec.name, description: spec.description, allowedTargets: spec.allowedTargets },
      }));
      log.item(`+ connector ${spec.name}`);
    }
    state.connectors[spec.key] = connector.id;
    const tokens = items(await listConnectorTokens(db, actor, { projectId, connectorId: connector.id }));
    for (let n = tokens.length; n < spec.tokens; n += 1) {
      await createConnectorToken(db, actor, { projectId, connectorId: connector.id });
      log.item(`  + agent token ${n + 1} for ${spec.name}`);
    }
  }

  const certs = items(await listClientCertificates(db, actor, { projectId }));
  let cert = certs.find((row) => row.description === "Backend mTLS: staging gateway → recommendation engine");
  if (!cert) {
    cert = body(await generateClientCertificate(db, actor, {
      projectId, input: { description: "Backend mTLS: staging gateway → recommendation engine", commonName: "pods-staging.geiger-notes.dev" },
    }));
    log.item("+ client certificate pods-staging.geiger-notes.dev");
  } else {
    log.skip("client certificate");
  }
  state.clientCertificateId = cert.id;

  const stores = items(await listTrustStores(db, actor, { projectId }));
  let store = stores.find((row) => row.name === "partner-ca-bundle");
  if (!store) {
    const rootA = issueSelfSignedCertificate({ commonName: "Geiger Partners Root CA" });
    const rootB = issueSelfSignedCertificate({ commonName: "Crunchy Recs Issuing CA" });
    store = body(await createTrustStore(db, actor, {
      projectId, input: { name: "partner-ca-bundle", pemBundle: `${rootA.certificatePem}\n${rootB.certificatePem}` },
    }));
    log.item("+ trust store partner-ca-bundle (2 CAs)");
  } else {
    log.skip("trust store partner-ca-bundle");
  }
  state.trustStoreId = store.id;
}

/** Custom domains need deployed stages, so this runs after releases. */
export async function seedDomains(ctx, state) {
  const { db, actor, projectId, log } = ctx;
  log.section("Custom domains");
  const domains = items(await listDomains(db, actor, { projectId, limit: 100 }));

  // 1) Fully provisioned public domain: verified + certificate imported.
  const anime = await ensureDomain(ctx, domains, {
    domainName: "anime.geiger-notes.dev",
    input: { endpointType: "REGIONAL", securityPolicy: "TLS13_1_2_STRICT", routingMode: "ROUTING_RULE_THEN_API_MAPPING" },
    provision: true,
  });
  const mappings = items(await listMappings(db, actor, { projectId, domainId: anime.id }));
  const wantMappings = [
    { apiId: state.rest.apiId, stage: "prod", basePath: "v1" },
    { apiId: state.rest.apiId, stage: "staging", basePath: "v1-preview" },
    { apiId: state.http.apiId, stage: "$default", basePath: "graphql" },
  ];
  for (const mapping of wantMappings) {
    if (mappings.some((row) => (row.basePath ?? row.base_path) === mapping.basePath)) continue;
    await createMapping(db, actor, { projectId, domainId: anime.id, input: mapping });
    log.item(`  + mapping /${mapping.basePath} → ${mapping.stage}`);
  }
  const rules = items(await listRoutingRules(db, actor, { projectId, domainId: anime.id }));
  if (rules.length === 0) {
    await createRoutingRule(db, actor, {
      projectId, domainId: anime.id,
      input: {
        priority: 10,
        conditions: { matchHeaders: [{ header: "x-pods-preview", valueGlob: "true" }] },
        action: { invokeApi: { apiId: state.rest.apiId, stage: "staging", stripBasePath: false } },
      },
    }).catch(async (error) => {
      // Reserved prefix — fall back to a neutral header name.
      if (error?.status !== 422) throw error;
      await createRoutingRule(db, actor, {
        projectId, domainId: anime.id,
        input: {
          priority: 10,
          conditions: { matchHeaders: [{ header: "x-preview", valueGlob: "true" }] },
          action: { invokeApi: { apiId: state.rest.apiId, stage: "staging", stripBasePath: false } },
        },
      });
    });
    await createRoutingRule(db, actor, {
      projectId, domainId: anime.id,
      input: {
        priority: 20,
        conditions: { matchBasePaths: ["v2"] },
        action: { invokeApi: { apiId: state.rest.apiId, stage: "dev", stripBasePath: true } },
      },
    });
    log.item("  + routing rules: preview header → staging, /v2 → dev");
  }

  // 2) Partner domain with mutual TLS against the partner CA bundle.
  const partners = await ensureDomain(ctx, domains, {
    domainName: "partners.geiger-notes.dev",
    input: { endpointType: "REGIONAL", securityPolicy: "TLS_1_2" },
    provision: true,
  });
  if (!(partners.mtls?.truststoreId)) {
    await updateDomain(db, actor, { projectId, domainId: partners.id, patch: { mtls: { truststoreId: state.trustStoreId } } });
    log.item("  = mTLS on partners.geiger-notes.dev (partner-ca-bundle)");
  }
  const partnerMappings = items(await listMappings(db, actor, { projectId, domainId: partners.id }));
  if (partnerMappings.length === 0) {
    await createMapping(db, actor, { projectId, domainId: partners.id, input: { apiId: state.rest.apiId, stage: "prod", basePath: "" } });
    log.item("  + mapping / → prod");
  }

  // 3) A domain still waiting for its DNS challenge (shows the setup flow).
  const pending = await ensureDomain(ctx, domains, {
    domainName: "live.geiger-notes.dev",
    input: { endpointType: "REGIONAL" },
    provision: false,
  });
  if (state.connectors?.archive && !(state.domainAssociations)) {
    await associateConnector(db, actor, { projectId, domainId: pending.id, input: { connectorId: state.connectors.archive } }).catch(() => {});
    state.domainAssociations = true;
  }
  state.domains = { anime: anime.id, partners: partners.id, live: pending.id };
}

async function ensureDomain(ctx, domains, { domainName, input, provision }) {
  const { db, actor, projectId, log } = ctx;
  let domain = domains.find((row) => row.domainName === domainName);
  if (domain) {
    log.skip(`domain ${domainName}`);
    return domain;
  }
  domain = body(await createDomain(db, actor, { projectId, input: { domainName, ...input } }));
  log.item(`+ domain ${domainName}`);
  if (!provision) return domain;
  const token = domain.verificationToken;
  // DNS-over-HTTPS stub: answers the _pods-challenge TXT record as if it were published.
  const dohFetch = async () => ({ ok: true, status: 200, json: async () => ({ Status: 0, Answer: [{ type: 16, data: `"${token}"` }] }) });
  domain = body(await verifyDomain(db, actor, { projectId, domainId: domain.id, dohFetch }));
  const cert = issueSelfSignedCertificate({ commonName: domainName });
  domain = body(await importCertificate(db, actor, { projectId, domainId: domain.id, chainPem: cert.certificatePem, keyPem: cert.privateKeyPem }));
  log.item(`  verified + certificate → ${domain.status}`);
  return domain;
}
