/**
 * Generates `docs/limits.md` from `lib/gateway/core/limits.mjs`.
 *
 * Usage: `node scripts/gen-limits-doc.mjs` (writes the doc; exits non-zero
 * when `--check` is passed and the doc is out of sync, for CI).
 *
 * @module scripts/gen-limits-doc
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "limits.md");

function formatDefault(value) {
  if (typeof value === "number" && value >= 1024 && value % 1024 === 0) {
    const kb = value / 1024;
    if (kb % 1024 === 0) return `${value.toLocaleString("en-US")} (${kb / 1024} MB)`;
    return `${value.toLocaleString("en-US")} (${kb} KB)`;
  }
  if (typeof value === "number") return value.toLocaleString("en-US");
  return String(value);
}

export async function renderLimitsDoc() {
  const { LIMIT_TABLE } = await import("../lib/gateway/core/limits.mjs");
  const rows = LIMIT_TABLE.map(
    (entry) =>
      `| ${entry.description} | ${formatDefault(entry.default)} | ${entry.adjustable ? "yes" : "no"} |`,
  );
  return `# Pods limits

Defaults match AWS (S15 §1). Columns: **adjustable** means a project
override in \`project_settings.features.limits\` (set by Geiger staff via
SQL, not by users). Every limit has one constant in
\`lib/gateway/core/limits.mjs\`; this doc is generated from that module by
\`scripts/gen-limits-doc.mjs\` (a test checks they stay in sync).

| Limit | Default | Adjustable |
|---|---|---|
${rows.join("\n")}

Source: \`lib/gateway/core/limits.mjs\` (\`LIMIT_TABLE\`).
`;
}

async function main() {
  const check = process.argv.includes("--check");
  const doc = await renderLimitsDoc();
  if (check) {
    const current = readFileSync(OUT, "utf8");
    if (current !== doc) {
      console.error("docs/limits.md is out of sync with lib/gateway/core/limits.mjs (run node scripts/gen-limits-doc.mjs).");
      process.exit(1);
    }
    console.log("docs/limits.md is in sync.");
    return;
  }
  writeFileSync(OUT, doc);
  console.log(`wrote ${OUT}`);
}

const invokedAsMain = process.argv[1] && /gen-limits-doc\.mjs$/.test(String(process.argv[1]));
if (invokedAsMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
