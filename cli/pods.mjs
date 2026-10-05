#!/usr/bin/env node
// `pods` CLI entry (S14 §3). Node ≥ 22, `node:util.parseArgs` only.
// Exit codes: 0 ok, 1 error, 2 usage, 3 plan has changes.

import { parseArgs } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createClient, loadProfiles, resolveConnection } from "./client.mjs";
import { COMMANDS, helpText, matchCommand } from "./commands.mjs";
import { format } from "./output.mjs";

const GLOBAL_OPTIONS = {
  profile: { type: "string", default: "default" },
  project: { type: "string" },
  "base-url": { type: "string" },
  output: { type: "string", default: "human" },
  file: { type: "string", short: "f" },
  "auto-approve": { type: "boolean", default: false },
  prune: { type: "boolean", default: false },
  "detailed-exitcode": { type: "boolean", default: false },
  api: { type: "string" },
  stage: { type: "string" },
  name: { type: "string" },
  protocol: { type: "string" },
  description: { type: "string" },
  method: { type: "string" },
  resource: { type: "string" },
  body: { type: "string" },
  limit: { type: "string" },
  token: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
};

async function main(argv) {
  if (argv[0] === "login") return login(argv.slice(1));
  if (argv[0] === "whoami") return whoami(argv.slice(1));
  const { key, rest } = matchCommand(argv);
  if (key === null) {
    if (argv.length > 0 && !argv.includes("--help") && !argv.includes("-h")) {
      console.error(`Unknown command: ${argv.join(" ")}`);
      return 2;
    }
    console.log(helpText());
    return 0;
  }
  const { values } = parseArgs({ args: rest, options: GLOBAL_OPTIONS, allowPositionals: true });
  const profiles = await loadProfiles();
  const connection = resolveConnection({ ...values, baseUrl: values["base-url"], profiles });
  if (!connection.token) {
    console.error("Not logged in. Run `pods login --token …` or set PODS_TOKEN.");
    return 1;
  }
  const client = createClient({ ...connection, fetchImpl: globalThis.fetch });
  try {
    const { data, exitCode = 0 } = await COMMANDS[key](client, values, { profiles });
    if (data !== undefined) console.log(format(data, { output: values.output }));
    return exitCode;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    return error.exitCode ?? 1;
  }
}

async function login(argv) {
  const { values } = parseArgs({ args: argv, options: GLOBAL_OPTIONS, allowPositionals: true });
  if (!values.token) {
    console.error("Usage: pods login --token <token> [--profile name]");
    return 2;
  }
  const configPath = join(homedir(), ".config", "pods", "config.json");
  let config = {};
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    config = {};
  }
  config.profiles = config.profiles ?? {};
  config.profiles[values.profile ?? "default"] = {
    ...(config.profiles[values.profile ?? "default"] ?? {}),
    ...(values["base-url"] ? { baseUrl: values["base-url"] } : {}),
    ...(values.project ? { projectId: values.project } : {}),
    token: values.token,
  };
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Saved profile "${values.profile ?? "default"}" to ${configPath}.`);
  return 0;
}

async function whoami(argv) {
  const { values } = parseArgs({ args: argv, options: GLOBAL_OPTIONS, allowPositionals: true });
  const profiles = await loadProfiles();
  const connection = resolveConnection({ ...values, baseUrl: values["base-url"], profiles });
  if (!connection.token) {
    console.error("Not logged in.");
    return 1;
  }
  console.log(format({ profile: values.profile ?? "default", baseUrl: connection.baseUrl, projectId: connection.projectId ?? "(none)", authenticated: true }, { output: values.output }));
  return 0;
}

const code = await main(process.argv.slice(2));
process.exit(code);
