/**
 * `canary` phase (pipeline row 7 — pick canary or base deployment).
 *
 * S09 implementation (replaces the S01 no-op stub, keeping the exported
 * `name` and `run(ctx)` contract).
 *
 * With a canary present (`ctx.canaryConfig` / `artifact.canary` plus a
 * canary artifact at `ctx.canaryArtifact` / `artifact.canaryArtifact`), draws
 * `rng() * 100 < percentTraffic` (RNG from `ports.rng`, `ctx.rng`, or
 * `Math.random` so tests seed it). A canary request uses the canary artifact,
 * stage variables merged with the overrides, and the stage cache only when
 * `useStageCache`. Sets `$context.isCanaryRequest = "true"`.
 *
 * Metrics carry `stage = "{stage}/Canary"` via the S10 event (`canary: true`
 * from `isCanaryRequest`); logs carry `canary: true` the same way.
 *
 * @module lib/gateway/core/phases/canary
 */

import { mergeStageVariables, shouldRouteToCanary } from "../release/canary.mjs";

/** Phase name as listed in the pipeline table (§3). */
export const name = "canary";

/**
 * Picks the canary or base deployment for this request.
 *
 * @param {object} ctx - Pipeline context.
 * @returns {Promise<undefined>}
 */
export async function run(ctx) {
  const artifact = ctx?.artifact ?? {};
  if ((artifact.protocol ?? "REST") !== "REST") return undefined;
  const config = ctx?.canaryConfig ?? artifact.canary ?? null;
  if (!config) {
    if (ctx?.context) ctx.context.isCanaryRequest = "";
    return undefined;
  }
  const percent = Number(config.percentTraffic ?? config.percent_traffic ?? 0);
  if (!(percent > 0)) {
    if (ctx?.context) ctx.context.isCanaryRequest = "";
    return undefined;
  }
  const canaryArtifact = ctx?.canaryArtifact ?? artifact.canaryArtifact ?? null;
  if (!canaryArtifact) {
    if (ctx?.context) ctx.context.isCanaryRequest = "";
    return undefined;
  }
  const rng = ctx?.ports?.rng ?? ctx?.rng ?? Math.random;
  const toCanary = shouldRouteToCanary({ canary: config, request: ctx?.request, rng });
  if (!toCanary) {
    if (ctx?.context) ctx.context.isCanaryRequest = "";
    return undefined;
  }
  // Swap to the canary artifact (same stage; match already ran against the
  // same route shape). Preserve the live stage name/variables plumbing.
  const stage = artifact.stage ?? ctx?.stage ?? ctx?.context?.stage ?? "";
  const baseVariables = ctx?.stageVariables ?? artifact.stageVariables ?? {};
  const overrides = config.stageVariableOverrides ?? config.stage_variable_overrides ?? {};
  ctx.stageVariables = mergeStageVariables(baseVariables, overrides);
  ctx.artifact = {
    ...canaryArtifact,
    stage,
    stageVariables: { ...ctx.stageVariables },
    deploymentId: canaryArtifact.deploymentId ?? config.deploymentId ?? config.deployment_id ?? canaryArtifact.digest ?? "",
  };
  ctx.isCanary = true;
  ctx.canaryNoCache = !(config.useStageCache ?? config.use_stage_cache ?? false);
  if (ctx?.context) {
    ctx.context.isCanaryRequest = "true";
    ctx.context.deploymentId = ctx.artifact.deploymentId ?? "";
    ctx.context.stage = stage;
  }
  return undefined;
}
