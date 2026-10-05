// Backend client-certificate management service (S04 §6, REST): generate
// (RSA-2048 self-signed), download the public PEM so backends can trust it,
// rotate by create → switch stage → delete. Private keys live in the vault;
// rows and API responses carry the public PEM only.

import { newPublicId } from "../gateway/ids.mjs";
import { v, validate } from "./validate.mjs";
import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { issueSelfSignedCertificate } from "./cert-issue.mjs";
import { createSecret as vaultCreate } from "../vault/secrets.mjs";

const CREATE_SCHEMA = v.object({
  description: v.optional(v.string({ max: 1024 })),
  commonName: v.optional(v.string({ min: 1, max: 64, pattern: "^[A-Za-z0-9._-]+$" })),
});

function certView(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    publicId: row.public_id,
    description: row.description ?? null,
    certificatePem: row.certificate_pem,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    version: row.version,
  };
}

async function scopedCertificate(db, projectId, certificateId) {
  const row = await db.getClientCertificateById(certificateId);
  if (!row || row.project_id !== projectId || row.deleted_at) {
    throw new HttpError(404, "not_found", "Client certificate does not exist.");
  }
  return row;
}

/** List client certificates (public material only). Supports `?tag:Key=Value` filters (F26). */
export async function listClientCertificates(db, actor, { projectId, tagFilters = [] }) {
  await requirePermission(db, actor, "pods.client_cert.write", { projectId });
  const rows = await db.listClientCertificates({ projectId });
  if (!tagFilters || tagFilters.length === 0) return { items: rows.map(certView) };
  const { matchesTagFilters, resolveResourceTags } = await import("./tags.mjs");
  const kept = [];
  for (const row of rows) {
    const tags = await resolveResourceTags(db, { projectId, resourceType: "client_certificate", resourceId: row.id, rowTags: row.tags });
    if (matchesTagFilters(tags, tagFilters)) kept.push(row);
  }
  return { items: kept.map(certView) };
}

/** Get one certificate, including the PEM for backend trust-store download. */
export async function getClientCertificate(db, actor, { projectId, certificateId }) {
  await requirePermission(db, actor, "pods.client_cert.write", { projectId });
  return certView(await scopedCertificate(db, projectId, certificateId));
}

/**
 * Generate a certificate: RSA-2048 self-signed, private key sealed in the
 * vault as a `client_certificate` secret, public PEM on the row.
 */
export async function generateClientCertificate(db, actor, { projectId, input, requestId = null }, deps = {}) {
  await requirePermission(db, actor, "pods.client_cert.write", { projectId });
  const clean = validate(CREATE_SCHEMA, input ?? {});
  const issue = deps.issueCertificate ?? issueSelfSignedCertificate;
  const issued = issue({ commonName: clean.commonName ?? "pods-backend-client" });
  if (!issued?.certificatePem || !issued?.privateKeyPem) {
    throw new HttpError(500, "internal_error", "Certificate generation is unavailable.");
  }
  const secretName = `client-cert-${newPublicId()}`;
  const created = deps.createSecretFn ?? vaultCreate;
  const secret = await created(db, actor, {
    projectId,
    name: secretName,
    kind: "client_certificate",
    value: { certificatePem: issued.certificatePem, privateKeyPem: issued.privateKeyPem },
    description: clean.description ?? "Backend client certificate",
    expiresAt: null,
  }, deps);
  const row = await db.insertClientCertificate({
    project_id: projectId,
    public_id: newPublicId(),
    description: clean.description ?? null,
    certificate_pem: issued.certificatePem,
    private_key_ref: `secret:${secret.id}`,
    expires_at: issued.notAfter instanceof Date ? issued.notAfter.toISOString() : new Date(issued.notAfter).toISOString(),
    created_by: actor?.userId ?? null,
  });
  const view = certView(row);
  await audit(db, actor, {
    action: "client_cert.create", resourceType: "client_certificate", resourceId: row.id,
    projectId, before: null, after: view, requestId,
  });
  return { status: 201, body: view };
}

/** Delete a certificate (refused while a stage still references it). */
export async function deleteClientCertificate(db, actor, { projectId, certificateId, requestId = null }) {
  await requirePermission(db, actor, "pods.client_cert.write", { projectId });
  const current = await scopedCertificate(db, projectId, certificateId);
  const usedBy = await db.countClientCertReferences(current.id);
  if (usedBy > 0) {
    throw new HttpError(409, "conflict", `Certificate is still referenced by ${usedBy} stage(s); switch the stage first.`);
  }
  await db.deleteClientCertificate(current.id);
  await audit(db, actor, {
    action: "client_cert.delete", resourceType: "client_certificate", resourceId: current.id,
    projectId, before: certView(current), after: null, requestId,
  });
  return { id: current.id, deleted: true };
}
