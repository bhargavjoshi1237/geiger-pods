// Project settings, vault secrets and team access.

import { getSettings, updateSettings } from "../../../lib/control/settings.mjs";
import { createSecretService, listSecrets, rotateSecretService } from "../../../lib/control/secrets.mjs";
import { createRoleGrant, listRoleGrants } from "../../../lib/control/role-grants.mjs";
import { body, items } from "../context.mjs";

/** Demo personas (geiger.studio accounts in the Geiger Notes organization). */
const TEAM = [
  { userId: "c318ad4e-a768-419f-9631-78d8880e4821", email: "marcus.whitfield@geiger.studio", roleKey: "admin" },
  { userId: "956dfff3-ce70-41a8-9b81-5036e8840cc3", email: "danielle.reyes@geiger.studio", roleKey: "manager" },
  { userId: "ab127d9d-9980-4e4b-94ae-02295d8cd74a", email: "ethan.caldwell@geiger.studio", roleKey: "writer" },
  { userId: "8edf3f51-bd5b-43e2-876e-38d37cd37774", email: "aisha.bennett@geiger.studio", roleKey: "writer" },
  { userId: "6af2bea9-ad17-4fd3-9d65-9c9e961c3f5c", email: "tyler.brennan@geiger.studio", roleKey: "viewer" },
  { userId: "487b573b-17ab-43b4-84a2-f4625f24d6c3", email: "grace.donnelly@geiger.studio", roleKey: "viewer" },
];

/**
 * Vault secrets. AniList's public GraphQL API needs no key, so the secrets are
 * the credentials a real deployment of this showcase would hold: an OAuth
 * client for AniList's authenticated API, the header Pods injects into every
 * upstream call, and delivery credentials for log sinks / webhooks.
 * Values are demo placeholders generated at seed time.
 */
function secretSpecs(random) {
  return [
    {
      name: "anilist-oauth-client", kind: "oauth_client",
      description: "AniList API client (anilist.co/settings/developer) for the authenticated viewer endpoints.",
      value: { tokenUrl: "https://anilist.co/api/v2/oauth/token", clientId: "21458", clientSecret: random(40), scope: "read" },
    },
    {
      name: "anilist-upstream-tag", kind: "header",
      description: "Injected by Pods on every AniList call (X-Geiger-Client) so AniList can attribute traffic; consumers never see it.",
      value: { name: "X-Geiger-Client", value: `geiger-notes-${random(24)}` },
      rotate: { name: "X-Geiger-Client", value: `geiger-notes-${random(24)}` },
    },
    {
      name: "datadog-api-key", kind: "generic",
      description: "Datadog EU intake key for the access-log export sink.",
      value: { value: random(32) },
    },
    {
      name: "log-archive-s3", kind: "aws_credentials",
      description: "Write-only IAM user for the s3://geiger-notes-pods-logs archive bucket.",
      value: { accessKeyId: `AKIA${random(16).toUpperCase()}`, secretAccessKey: random(40), region: "ap-south-1" },
    },
    {
      name: "grafana-otlp-token", kind: "bearer",
      description: "Grafana Cloud OTLP logs token.",
      value: { token: `glc_${random(48)}` },
    },
    {
      name: "webhook-signing-secret", kind: "generic",
      description: "HMAC secret Pods signs deployment/key event webhooks with.",
      value: { value: random(48) },
    },
    {
      name: "recs-engine-basic-auth", kind: "basic_auth",
      description: "Basic auth for the on-prem recommendation engine reached through the Pods Connector.",
      value: { username: "pods-gateway", password: random(28) },
    },
  ];
}

export async function seedFoundation(ctx, state) {
  const { db, actor, projectId, log } = ctx;
  log.section("Project settings");
  const current = body(await getSettings(db, actor, { projectId }));
  await updateSettings(db, actor, {
    projectId,
    expectedVersion: current?.version ?? null,
    patch: {
      throttleRate: 2000,
      throttleBurst: 1000,
      throttleKvFailure: "open",
      logRetentionDays: 30,
      dataTraceRetentionDays: 7,
      defaultRegion: "ap-south-1",
      maxIntegrationTimeoutMs: 29000,
      features: { rateLimitHeaders: true, echoTraceparent: true, brotliCompression: true, corsWildcardSubdomains: true },
    },
  });
  log.item("throttle 2000 rps / burst 1000, 30-day log retention, rate-limit headers on");

  log.section("Vault secrets");
  const existing = items(await listSecrets(db, actor, { projectId, limit: 100 }));
  state.secrets = {};
  for (const spec of secretSpecs(state.random)) {
    let secret = existing.find((row) => row.name === spec.name);
    if (secret) {
      log.skip(spec.name);
    } else {
      secret = body(await createSecretService(db, actor, {
        projectId, name: spec.name, kind: spec.kind, value: spec.value, description: spec.description,
      }));
      log.item(`+ ${spec.name} (${spec.kind})`);
      if (spec.rotate) {
        await rotateSecretService(db, actor, { projectId, secretId: secret.id, value: spec.rotate });
        log.item(`  rotated ${spec.name} → v2`);
      }
    }
    state.secrets[spec.name] = secret.id;
  }

  log.section("Team & access");
  const grants = items(await listRoleGrants(db, actor, { projectId }));
  // pods.grant_role authorizes auth.uid(), which the service role lacks; the
  // seed performs the same insert with the owner as grantor (the owner holds
  // "*", so the function's grantor checks would pass).
  const grantDb = {
    ...db,
    async grantRole({ projectId: project, userId, roleKey, scope }) {
      const role = await db.getRoleByKey({ projectId: project, roleKey });
      const { data, error } = await ctx.supabase.schema("pods").from("role_grants")
        .insert({ project_id: project, user_id: userId, role_id: role.id, scope: scope ?? {}, granted_by: actor.userId })
        .select("id").single();
      if (error) throw new Error(error.message);
      return { id: data.id, projectId: project, userId, roleKey, scope: scope ?? {} };
    },
  };
  for (const member of TEAM) {
    if (grants.some((grant) => grant.userId === member.userId)) {
      log.skip(`${member.email} (${member.roleKey})`);
      continue;
    }
    await createRoleGrant(grantDb, actor, { projectId, userId: member.userId, roleKey: member.roleKey });
    log.item(`+ ${member.email} → ${member.roleKey}`);
  }
}
