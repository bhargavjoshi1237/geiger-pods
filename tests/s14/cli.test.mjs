import assert from "node:assert/strict";
import test from "node:test";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS, matchCommand, helpText } from "../../cli/commands.mjs";
import { format, table } from "../../cli/output.mjs";
import { createClient, resolveConnection } from "../../cli/client.mjs";

function stubClient(routes = {}) {
  return {
    async get(path) {
      if (routes[`GET ${path}`]) return routes[`GET ${path}`];
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path, { body } = {}) {
      const handler = routes[`POST ${path}`];
      if (!handler) throw new Error(`unexpected POST ${path}`);
      return typeof handler === "function" ? handler(body) : handler;
    },
    async del(path) {
      if (routes[`DELETE ${path}`]) return routes[`DELETE ${path}`];
      throw new Error(`unexpected DELETE ${path}`);
    },
  };
}

test("S14: CLI apis create → deploy flow against a stub client; tables render", async () => {
  const client = stubClient({
    "POST /apis": (body) => ({ id: "api-1", name: body.name, protocol: body.protocol }),
    "POST /apis/api-1/deployments": (body) => ({ id: "d-1", stageName: body.stageName }),
  });
  const created = await COMMANDS["apis create"](client, { name: "shop", protocol: "REST" });
  assert.equal(created.data.id, "api-1");
  const deployed = await COMMANDS.deploy(client, { api: "api-1", stage: "prod" });
  assert.equal(deployed.data.stageName, "prod");
  const rendered = format([{ id: "api-1", name: "shop" }], { output: "human" });
  assert.match(rendered, /api-1/);
  assert.match(format({ a: 1 }, { output: "json" }), /"a": 1/);
  assert.match(table(["a"], [["x"]]), /x/);
  assert.match(helpText(), /apis create/);
  assert.equal(matchCommand(["apis", "create", "--name", "x"]).key, "apis create");
  assert.equal(matchCommand(["nope"]).key, null);
});

test("S14: plan on unchanged stack → no changes (exit 0); edited throttle → one update", async () => {
  const dir = await mkTemp();
  try {
    const file = join(dir, "pods.yaml");
    await writeFile(file, "version: 1\nstack: s\n", "utf8");
    const client = stubClient({
      "POST /stacks/s/plan": { stack: "s", changes: [] },
    });
    const result = await COMMANDS.plan(client, { file, "detailed-exitcode": true });
    assert.deepEqual(result.data.changes, []);
    assert.equal(result.exitCode ?? 0, 0);
    const client2 = stubClient({
      "POST /stacks/s/plan": { stack: "s", changes: [{ kind: "api", name: "a", op: "update" }] },
    });
    const changed = await COMMANDS.plan(client2, { file, "detailed-exitcode": true });
    assert.equal(changed.exitCode, 3);
    // apply without --auto-approve is a usage error (exit 2).
    await assert.rejects(COMMANDS.apply(client2, { file }), (error) => error.exitCode === 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S14: client resolves flags > env > profile and requires a project", async () => {
  const resolved = resolveConnection({ projectId: "p1", profiles: { default: { projectId: "p0", token: "t" } } });
  assert.equal(resolved.projectId, "p1");
  assert.equal(resolved.token, "t");
  assert.throws(() => createClient({ baseUrl: "http://x", projectId: null }), /project/i);
  const client = createClient({
    baseUrl: "http://x", projectId: "p", token: "t",
    fetchImpl: async () => Response.json({ ok: true }),
  });
  assert.deepEqual(await client.get("/apis"), { ok: true });
});

async function mkTemp() {
  const dir = join(tmpdir(), `pods-cli-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
