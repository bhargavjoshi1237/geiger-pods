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

async function readDocumentFile(file) {
  if (!file) {
    const error = new Error("Missing required -f/--file (the OpenAPI document).");
    error.exitCode = 2;
    throw error;
  }
  return readFile(file, "utf8");
}

async function writeOutFile(out, text) {
  if (!out) return text;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(out, text, "utf8");
  return { written: out, bytes: Buffer.byteLength(text, "utf8") };
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
    // S09: `--canary <percent>` deploys to the canary only (AWS
    // CreateDeployment with canarySettings); otherwise a normal deploy.
    data: await client.post(`/apis/${need(args.api, "--api")}/deployments`, {
      body: {
        stageName: need(args.stage, "--stage"),
        description: args.description ?? "",
        ...(args.canary !== undefined && args.canary !== null
          ? { canary: { percentTraffic: Number(args.canary) } }
          : {}),
      },
    }),
  }),
  "canary get": async (client, args) => ({
    data: await client.get(`/apis/${need(args.api, "--api")}/stages/${need(args.stage, "--stage")}/canary`),
  }),
  "canary set": async (client, args) => ({
    data: await client.put(`/apis/${need(args.api, "--api")}/stages/${need(args.stage, "--stage")}/canary`, {
      body: {
        percentTraffic: Number(args.percent ?? 10),
        stageVariableOverrides: args.overrides ? JSON.parse(args.overrides) : {},
        useStageCache: args["use-stage-cache"] === true,
      },
    }),
  }),
  "canary promote": async (client, args) => ({
    data: await client.post(`/apis/${need(args.api, "--api")}/stages/${need(args.stage, "--stage")}/canary/promote`, {
      body: { mergeVariables: args.merge === true, removeCanary: args.remove === true },
    }),
  }),
  "canary delete": async (client, args) => ({
    data: await client.del(`/apis/${need(args.api, "--api")}/stages/${need(args.stage, "--stage")}/canary`),
  }),
  "cache get": async (client, args) => ({
    data: await client.get(`/apis/${need(args.api, "--api")}/stages/${need(args.stage, "--stage")}/cache`),
  }),
  "cache flush": async (client, args) => ({
    data: await client.del(`/apis/${need(args.api, "--api")}/stages/${need(args.stage, "--stage")}/cache`),
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
  "import": async (client, args) => {
    const document = await readDocumentFile(args.file);
    const query = {
      ...(args.mode ? { mode: args.mode } : {}),
      ...(args.protocol ? { protocol: args.protocol } : {}),
      ...(args.basepath ? { basepath: args.basepath } : {}),
      ...(args["fail-on-warnings"] ? { failOnWarnings: "true" } : {}),
      ...(args["dry-run"] ? { dryRun: "true" } : {}),
    };
    if (args.api) {
      return { data: await client.put(`/apis/${args.api}/import`, { body: { document }, query }) };
    }
    return { data: await client.post("/apis/import", { body: { document }, query }) };
  },
  "export": async (client, args) => {
    const api = need(args.api, "--api");
    const query = {
      ...(args.type ? { type: args.type } : {}),
      ...(args.format ? { format: args.format } : {}),
      ...(args.extensions ? { extensions: args.extensions } : {}),
      ...(args["include-docs"] ? { includeDocs: "true" } : {}),
      ...(args.domain ? { domain: args.domain } : {}),
    };
    const result = args.source === "draft" || !args.stage
      ? await client.get(`/apis/${api}/export`, { query })
      : await client.get(`/apis/${api}/stages/${args.stage}/export`, { query });
    const text = typeof result.document === "string" ? result.document : JSON.stringify(result.document, null, 2);
    if (args.out) return { data: await writeOutFile(args.out, text) };
    return { data: result };
  },
  "domains list": async (client) => ({ data: await client.get("/domains") }),
  "domains create": async (client, args) => ({
    data: await client.post("/domains", {
      body: {
        domainName: need(args.domain ?? args.name, "--domain"),
        endpointType: args["endpoint-type"] ?? undefined,
        ipAddressType: args["ip-address-type"] ?? undefined,
        securityPolicy: args["security-policy"] ?? undefined,
        routingMode: args["routing-mode"] ?? undefined,
        certificateMode: args["certificate-mode"] ?? undefined,
      },
    }),
  }),
  "domains verify": async (client, args) => ({
    data: await client.post(`/domains/${need(args.domain, "--domain")}/verify`, {}),
  }),
  "domains delete": async (client, args) => ({
    data: await client.del(`/domains/${need(args.domain, "--domain")}`),
  }),
  "ws send": async (client, args) => ({
    data: await client.post(`/apis/${need(args.api, "--api")}/stages/${need(args.stage, "--stage")}/connections/${need(args.connection ?? args.id, "--connection")}`, {
      body: { data: await readMaybeFile(args.message ?? args.data ?? "") },
    }),
  }),
  "ws info": async (client, args) => ({
    data: await client.get(`/apis/${need(args.api, "--api")}/stages/${need(args.stage, "--stage")}/connections/${need(args.connection ?? args.id, "--connection")}`),
  }),
  "ws disconnect": async (client, args) => ({
    data: await client.del(`/apis/${need(args.api, "--api")}/stages/${need(args.stage, "--stage")}/connections/${need(args.connection ?? args.id, "--connection")}`),
  }),
  "sdk generate": async (client, args) => {
    const api = need(args.api, "--api");
    const stage = need(args.stage, "--stage");
    const job = await client.post(`/apis/${api}/stages/${stage}/sdks`, {
      body: {
        language: args.language ?? "typescript",
        config: {
          ...(args.package ? { packageName: args.package } : {}),
          ...(args["package-version"] ? { version: args["package-version"] } : {}),
        },
      },
    });
    if (args.out) return { data: await writeOutFile(args.out, JSON.stringify(job, null, 2)) };
    return { data: job };
  },
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
