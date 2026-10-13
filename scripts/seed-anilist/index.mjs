#!/usr/bin/env node
// Seeds the Geiger Notes project's Pods workspace with an AniList showcase
// that exercises every Pods feature. Re-runnable: each step finds existing
// rows by name and only creates what is missing.
//
//   node scripts/seed-anilist/index.mjs [--only step1,step2]
//
// Steps run as bhargavjoshi1237@gmail.com (project owner) through the same
// control-plane services the management API uses. One-time secrets (API key
// values, access tokens, signing secrets) are written to
// scripts/seed-anilist/output/ (git-ignored), never printed.

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createSeedContext, ROOT } from "./context.mjs";
import { seedFoundation } from "./steps/foundation.mjs";
import { seedConnectors, seedDomains } from "./steps/networking.mjs";
import { seedRestApi } from "./steps/rest-api.mjs";
import { seedHttpApi, seedWebSocketApi } from "./steps/http-ws-apis.mjs";
import { seedReleases } from "./steps/releases.mjs";
import { seedUsage } from "./steps/usage.mjs";
import { seedSecurity } from "./steps/security.mjs";
import { seedAdmin, seedMonitoring, seedPortal } from "./steps/operations.mjs";
import { seedData } from "./steps/data.mjs";
import { seedLogs } from "./steps/logs.mjs";

const OUTPUT_DIR = join(ROOT, "scripts", "seed-anilist", "output");
const STATE_FILE = join(OUTPUT_DIR, "state.json");

const STEPS = [
  ["foundation", seedFoundation],
  ["connectors", seedConnectors],
  ["rest", seedRestApi],
  ["http", seedHttpApi],
  ["ws", seedWebSocketApi],
  ["releases", seedReleases],
  ["domains", seedDomains],
  ["usage", seedUsage],
  ["security", seedSecurity],
  ["monitoring", seedMonitoring],
  ["portal", seedPortal],
  ["admin", seedAdmin],
  ["data", seedData],
  ["logs", seedLogs],
];

function random(length) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(randomBytes(length), (byte) => alphabet[byte % alphabet.length]).join("");
}

async function main() {
  const onlyArg = process.argv.find((arg) => arg.startsWith("--only"));
  const only = onlyArg ? (onlyArg.split("=")[1] ?? process.argv[process.argv.indexOf(onlyArg) + 1] ?? "").split(",") : null;
  const ctx = createSeedContext();
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const saved = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
  const state = { ...saved, random };
  const persist = () => {
    const { random: _random, ...rest } = state;
    writeFileSync(STATE_FILE, `${JSON.stringify(rest, null, 2)}\n`);
  };
  for (const [name, step] of STEPS) {
    if (only && !only.includes(name)) continue;
    try {
      await step(ctx, state);
    } finally {
      persist();
    }
  }
  console.log(`\nDone. State: ${STATE_FILE}`);
}

main().catch((error) => {
  console.error("\nSeed failed:", error?.status ?? "", error?.code ?? "", error?.message ?? error);
  if (error?.details) console.error(JSON.stringify(error.details, null, 2));
  if (process.env.SEED_DEBUG) console.error(error?.stack);
  process.exitCode = 1;
});
