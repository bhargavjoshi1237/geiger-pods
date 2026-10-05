// `pods` command implementations (S14 §3). Each command is
// `async (client, args, ctx) → { data, exitCode? }` so tests run them with
// a stub client and never touch the network.
//
// @module cli/commands
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

function need(value, flag) {
  if (!value) {
    const error = new Error(`Missing required ${flag}.`);
    error.exitCode = 2;
    throw error;
  }
  return value;
}

function stub(spec) {
  return async () => {
    const error = new Error(`${spec} is not implemented in this build yet.`);
    error.exitCode = 1;
    throw error;
  };
}

async function readMaybeFile(value) {
  if (typeof value === "string" && value.startsWith("@")) {
    const text = await readFile(value.slice(1), "utf8");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return value;
}

export const COMMANDS = {
  "apis list": async (client, args) => ({ data: await client.get("/apis", { query: { limit: args.limit } }) }),
  "apis get": async (client, args) => ({ data: await client.get(`/apis/${need(args.api, "--api")}`) }),
  "apis create": async (client, args) => ({
    data: await client.post("/apis", { body: { name: need(args.name, "--name"), protocol: args.protocol ?? "REST", description: args.description ?? "" } }),
  }),
  "apis delete": async (client, args) => ({ data: await client.del(`/apis/${need(args.api, "--api")}`) }),
  "apis clone": async (client, args) => ({
    data: await client.post(`/apis/${need(args.api, "--api")}/clone`, { body: { name: args.name ?? null } }),
  }),
  "deploy": async (client, args) => ({
    data: await client.post(`/apis/${need(args.api, "--api")}/deployments`, {
      body: { stageName: need(args.stage, "--stage"), description: args.description ?? "", canaryPercent: args.canary ?? null },
    }),
  }),
  "stages list": async (client, args) => ({ data: await client.get(`/apis/${need(args.api, "--api")}/stages`) }),
  "stages rollback": async (client, args) => ({
    data: await client.post(`/apis/${need(args.api, "--api")}/stages/${need(args.stage, "--stage")}/rollback`, {}),
  }),
  "test-invoke": async (client, args) => ({
    data: await client.post(
      `/apis/${need(args.api, "--api")}/resources/${need(args.resource, "--resource")}/methods/${need(args.method, "--method")}/test-invoke`,
      { body: { body: await readMaybeFile(args.body ?? null) } },
    ),
  }),
  "keys list": async (client) => ({ data: await client.get("/api-keys").catch(() => ({ note: "S08 endpoint lands with usage plans" })) }),
  "plans list": async (client) => ({ data: await client.get("/usage-plans").catch(() => ({ note: "S08 endpoint lands with usage plans" })) }),
  "logs tail": stub("S10 `logs tail` (log streaming)"),
  "metrics": stub("S10 `metrics`"),
  "import": stub("S13 `import` (OpenAPI)"),
  "export": stub("S13 `export` (OpenAPI)"),
  "domains list": stub("S11 `domains`"),
  "ws send": stub("S12 `ws`"),
  "plan": async (client, args, ctx) => {
    const file = parseYaml(await readFile(need(args.file, "-f/--file"), "utf8"));
    const stack = file.stack ?? args.stack;
    const result = await client.post(`/stacks/${stack}/plan`, { body: { file, prune: args.prune === true } });
    const changes = result.changes ?? [];
    if (args["detailed-exitcode"] && changes.length > 0) return { data: result, exitCode: 3 };
    return { data: result };
  },
  "apply": async (client, args) => {
    const file = parseYaml(await readFile(need(args.file, "-f/--file"), "utf8"));
    const stack = file.stack ?? args.stack;
    if (!args["auto-approve"] && process.env.PODS_ASSUME_YES !== "1") {
      const error = new Error(`Apply ${changesPlural(file)} to stack "${stack}"? Re-run with --auto-approve.`);
      error.exitCode = 2;
      throw error;
    }
    return { data: await client.post(`/stacks/${stack}/apply`, { body: { file, prune: args.prune === true } }) };
  },
  "drift": async (client, args) => {
    const file = parseYaml(await readFile(need(args.file, "-f/--file"), "utf8"));
    return { data: await client.post(`/stacks/${file.stack ?? args.stack}/drift`, { body: { file } }) };
  },
};

function changesPlural() {
  return "the planned changes";
}

/**
 * Finds the longest matching command key for argv tokens.
 *
 * @param {Array<string>} argv
 * @returns {{ key: string|null, rest: Array<string> }}
 */
export function matchCommand(argv) {
  const keys = Object.keys(COMMANDS).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    const parts = key.split(" ");
    if (parts.every((part, index) => argv[index] === part)) {
      return { key, rest: argv.slice(parts.length) };
    }
  }
  return { key: null, rest: argv };
}

/** Command synopses for `--help`. */
export function helpText() {
  const lines = ["Usage: pods <command> [options]", "", "Commands:"];
  for (const key of Object.keys(COMMANDS)) lines.push(`  ${key}`);
  lines.push("", "Global options: --profile, --project, --base-url, --output human|json|yaml, --auto-approve, --prune, -f/--file");
  return lines.join("\n");
}
