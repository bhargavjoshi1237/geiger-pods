/**
 * Parity report generator (S15 §5).
 *
 * Reads `docs/specs/gateway/parity-status.md` (S01) and writes
 * `docs/specs/gateway/parity-report.md`: per row, status, evidence tests
 * (pass/fail when a JSON reporter output is given), deviations, and
 * production evidence links. Also validates that no row is marked beyond
 * its evidence (the S15 acceptance gate):
 * - every `tests/...` evidence path must exist;
 * - `implemented` rows need at least one existing evidence file;
 * - `runtime-tested` rows need at least one evidence file containing runtime
 *   proof (`[runtime]`, `real gateway`, `createGatewayServer`, `startWsGateway`
 *   or `via real gateway`);
 * - `production-validated` rows need production evidence under
 *   `docs/specs/gateway/production-evidence/`.
 *
 * Usage: `node scripts/parity-report.mjs [--test-json <path>]`.
 *
 * @module scripts/parity-report
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATUS_PATH = join(ROOT, "docs", "specs", "gateway", "parity-status.md");
const OUT_PATH = join(ROOT, "docs", "specs", "gateway", "parity-report.md");

const ORDER = ["planned", "designed", "implemented", "runtime-tested", "production-validated"];

function parseRows(markdown) {
  const rows = [];
  let section = "";
  for (const line of markdown.split("\n")) {
    const heading = line.match(/^##\s+(.+)/);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    if (!line.startsWith("|") || line.includes("Feature |") || line.includes("---")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 5) continue;
    const [feature, types, spec, status, evidence] = cells;
    if (!ORDER.includes(status)) continue;
    rows.push({ section, feature, types, spec, status, evidence });
  }
  return rows;
}

function evidencePaths(evidence) {
  const paths = [];
  const pattern = /(tests\/[^\s,;)]+|docs\/[^\s,;)]+|supabase\/[^\s,;)]+|lib\/[^\s,;)]+|gateway\/[^\s,;)]+|app\/[^\s,;)]+)/g;
  let match;
  while ((match = pattern.exec(evidence)) !== null) {
    paths.push(match[1].replace(/[).]+$/, ""));
  }
  // Bare filenames (`control.test.mjs`) inherit the first tests/ directory in
  // the same cell (`tests/s11/domains.test.mjs + control.test.mjs`).
  const dirMatch = evidence.match(/(tests\/[^\s,;)]*\/)/);
  const dir = dirMatch ? dirMatch[1] : null;
  if (dir) {
    const barePattern = /(?:^|[\s+(])([A-Za-z0-9_.-]+\.test\.mjs)/g;
    let bare;
    while ((bare = barePattern.exec(evidence)) !== null) {
      const candidate = `${dir}${bare[1]}`;
      if (!paths.includes(candidate)) paths.push(candidate);
    }
  }
  return [...new Set(paths)];
}

/**
 * Expands a `tests/s08/*.test.mjs` glob to on-disk files (empty when none).
 *
 * @param {string} path
 * @returns {Array<string>}
 */
export function expandEvidenceGlob(path) {
  if (!path.includes("*")) return [path];
  try {
    const dir = join(ROOT, dirname(path));
    const base = path.split("/").pop();
    const pattern = new RegExp(`^${base.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`);
    return readdirSync(dir).filter((entry) => pattern.test(entry)).map((entry) => `${dirname(path)}/${entry}`);
  } catch {
    return [];
  }
}

function hasRuntimeProof(filePath) {
  try {
    const body = readFileSync(join(ROOT, filePath), "utf8");
    return /\[runtime\]|real gateway|createGatewayServer|startWsGateway|via real gateway/i.test(body);
  } catch {
    return false;
  }
}

/**
 * Validates one row against its evidence.
 *
 * @param {{ feature: string, status: string, evidence: string }} row
 * @returns {Array<string>} Problems (empty when the row is honest).
 */
export function validateRow(row) {
  const problems = [];
  if (row.status === "planned" || row.evidence.trim() === "—") return problems;
  const paths = evidencePaths(row.evidence);
  const testPaths = paths.filter((path) => path.startsWith("tests/"));
  if (testPaths.length === 0 && row.status !== "planned") {
    problems.push(`no test evidence path for status "${row.status}"`);
    return problems;
  }
  const expanded = testPaths.flatMap(expandEvidenceGlob);
  if (expanded.length === 0) {
    problems.push(`evidence matches no files: ${testPaths.join(", ")}`);
    return problems;
  }
  for (const path of testPaths) {
    if (path.includes("*")) continue;
    if (!existsSync(join(ROOT, path))) {
      problems.push(`evidence path does not exist: ${path}`);
    }
  }
  if (row.status === "runtime-tested") {
    const proven = expanded.some((path) => existsSync(join(ROOT, path)) && hasRuntimeProof(path));
    if (!proven) problems.push("runtime-tested without runtime proof in evidence files");
  }
  if (row.status === "production-validated") {
    const prodDir = join(ROOT, "docs", "specs", "gateway", "production-evidence");
    if (!existsSync(prodDir)) problems.push("production-validated without production-evidence/");
  }
  return problems;
}

export async function renderReport({ testJsonPath = null } = {}) {
  const markdown = readFileSync(STATUS_PATH, "utf8");
  const rows = parseRows(markdown);
  let results = new Map();
  if (testJsonPath && existsSync(testJsonPath)) {
    try {
      const raw = readFileSync(testJsonPath, "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const event = JSON.parse(trimmed);
          if (event?.type === "test:pass" || event?.type === "test:fail") {
            results.set(event?.data?.name, event.type === "test:pass" ? "pass" : "fail");
          }
        } catch {
          // Ignore non-JSON lines.
        }
      }
    } catch {
      // Test results are advisory; the report still renders.
    }
  }
  const lines = [
    "# Pods ⇄ AWS API Gateway parity report",
    "",
    `Generated ${new Date().toISOString()} from \`parity-status.md\`.`,
    "Status flow: `planned` → `designed` → `implemented` → `runtime-tested` → `production-validated`.",
    "No row may be marked beyond its evidence (S15 gate).",
    "",
    "| Section | Feature | Types | Spec | Status | Evidence | Evidence check |",
    "|---|---|---|---|---|---|---|",
  ];
  let problems = 0;
  for (const row of rows) {
    const rowProblems = validateRow(row);
    if (rowProblems.length > 0) problems += 1;
    const check = rowProblems.length === 0 ? "ok" : `beyond evidence: ${rowProblems.join("; ")}`;
    const evidence = row.evidence.length > 160 ? `${row.evidence.slice(0, 157)}…` : row.evidence;
    lines.push(`| ${row.section} | ${row.feature} | ${row.types} | ${row.spec} | ${row.status} | ${evidence} | ${check} |`);
  }
  lines.push("", `Rows: ${rows.length}. Rows beyond evidence: ${problems}.`, "");
  return { report: `${lines.join("\n")}\n`, rows, problems };
}

async function main() {
  const jsonIndex = process.argv.indexOf("--test-json");
  const testJsonPath = jsonIndex !== -1 ? process.argv[jsonIndex + 1] ?? null : null;
  const { report, problems } = await renderReport({ testJsonPath });
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, report);
  console.log(`wrote ${OUT_PATH} (rows beyond evidence: ${problems})`);
  if (problems > 0) process.exitCode = 1;
}

const invokedAsMain = process.argv[1] && /parity-report\.mjs$/.test(String(process.argv[1]));
if (invokedAsMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
