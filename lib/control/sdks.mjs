// SDK generation service (S13 part C).
//
// `POST …/stages/{stage}/sdks {language, config}` renders a client from the
// stage's deployed artifact (never the draft) via `loadExportContext` and
// caches the job by `(deploymentId, docsVersion, language, config hash)`.
// `GET …/sdks/{jobId}` downloads the stored zip. Jobs live in-process (like
// deploy locks); the cache key makes regeneration idempotent.
//
// @module lib/control/sdks

import { createHash, randomUUID } from "node:crypto";
import { HttpError } from "./errors.mjs";
import { requirePermission } from "./authz.mjs";
import { audit } from "./audit.mjs";
import { resolveApi } from "./apis.mjs";
import { loadExportContext } from "./openapi-export.mjs";
import { buildSdkFiles, createSdkZip, hashSdkConfig } from "../sdk/package.mjs";
import { checkSdkLanguage, cleanSdkConfig } from "../sdk/languages.mjs";

/** In-process SDK jobs: `jobId → job`. Reset by tests via `resetSdkJobs`. */
const SDK_JOBS = new Map();

/** Test hook: clears the in-process job store. */
export function resetSdkJobs() {
  SDK_JOBS.clear();
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJobView(job) {
  return {
    id: job.id, apiId: job.apiId, stage: job.stage, language: job.language,
    config: job.config, cacheKey: job.cacheKey, files: Object.keys(job.files),
    bytes: job.zip.byteLength, createdAt: job.createdAt,
  };
}

/**
 * Generates (or reuses a cached) SDK for a deployed stage.
 *
 * @returns {Promise<{ status: number, body: object, files: Record<string,string>, zip: Buffer }>}
 */
export async function generateSdk(db, actor, { projectId, apiId, stageName, language, config = {}, requestId = null }) {
  const api = await resolveApi(db, projectId, apiId);
  if (api.protocol !== "REST") {
    throw new HttpError(400, "capability_unsupported", "SDK generation is only available on REST APIs.");
  }
  await requirePermission(db, actor, "pods.sdk.generate", { projectId, apiId: api.id });
  const cleanLanguage = (() => {
    try {
      return checkSdkLanguage(language);
    } catch {
      throw new HttpError(422, "invalid_input", `Invalid request: $.language: must be one of javascript, typescript, python, java, android, swift, ruby, go, kotlin`);
    }
  })();
  let cleanConfig;
  try {
    cleanConfig = cleanSdkConfig(isObject(config) ? config : {});
  } catch (error) {
    throw new HttpError(422, "invalid_input", error.message);
  }
  if (typeof stageName !== "string" || stageName === "") {
    throw new HttpError(422, "invalid_input", "Invalid request: a stage name is required.");
  }
  const { stage, artifact, docsByLocation, invokeUrl } = await loadExportContext(db, {
    projectId, apiId, stageName,
  });
  const deploymentId = stage.deployment_id ?? stage.deploymentId ?? null;
  if (!deploymentId) throw new HttpError(409, "not_deployed", "Stage has no deployment to generate from.");
  const docsVersion = stage.documentation_version ?? stage.documentationVersion ?? null;
  const cacheKey = createHash("sha256")
    .update(JSON.stringify([deploymentId, docsVersion, cleanLanguage, hashSdkConfig(cleanConfig)]), "utf8")
    .digest("hex")
    .slice(0, 32);
  for (const job of SDK_JOBS.values()) {
    if (job.cacheKey === cacheKey) return { status: 200, body: toJobView(job), files: job.files, zip: job.zip };
  }
  const files = buildSdkFiles({ artifact, invokeUrl, docsByLocation, language: cleanLanguage, config: cleanConfig });
  const zip = createSdkZip(files);
  const job = {
    id: randomUUID(), apiId: api.id, stage: stage.name, language: cleanLanguage,
    config: cleanConfig, cacheKey, files, zip,
    createdAt: new Date().toISOString(), projectId, deploymentId,
  };
  SDK_JOBS.set(job.id, job);
  await audit(db, actor, {
    action: "sdk.generate", resourceType: "api", resourceId: api.id,
    projectId, apiId: api.id, before: null,
    after: { stage: stage.name, language: cleanLanguage, cacheKey }, requestId,
  });
  return { status: 201, body: toJobView(job), files, zip };
}

/** Downloads a generated SDK zip by job id. */
export async function downloadSdk(db, actor, { projectId, apiId, jobId }) {
  const api = await resolveApi(db, projectId, apiId);
  await requirePermission(db, actor, "pods.sdk.generate", { projectId, apiId: api.id });
  const job = SDK_JOBS.get(String(jobId));
  if (!job || job.apiId !== api.id) throw new HttpError(404, "not_found", "SDK job does not exist.");
  return { job: toJobView(job), zip: job.zip, files: job.files };
}

export { SUPPORTED_SDK_LANGUAGES } from "../sdk/languages.mjs";
