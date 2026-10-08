import assert from "node:assert/strict";
import test from "node:test";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS } from "../../cli/commands.mjs";

function stubClient(routes = {}) {
  const calls = [];
  const client = {
    calls,
    async get(path, opts) {
      calls.push({ method: "GET", path, opts });
      const handler = routes[`GET ${path}`];
      if (!handler) throw new Error(`unexpected GET ${path}`);
      return typeof handler === "function" ? handler(opts) : handler;
    },
    async post(path, opts) {
      calls.push({ method: "POST", path, opts });
      const handler = routes[`POST ${path}`];
      if (!handler) throw new Error(`unexpected POST ${path}`);
      return typeof handler === "function" ? handler(opts?.body) : handler;
    },
    async put(path, opts) {
      calls.push({ method: "PUT", path, opts });
      const handler = routes[`PUT ${path}`];
      if (!handler) throw new Error(`unexpected PUT ${path}`);
      return typeof handler === "function" ? handler(opts?.body) : handler;
    },
    async del() {
      throw new Error("unexpected DELETE");
    },
  };
  return client;
}

test("S13: CLI import reads a file and targets new vs existing APIs", async () => {
  const dir = join(tmpdir(), `pods-s13-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  try {
    const file = join(dir, "api.json");
    await writeFile(file, JSON.stringify({ swagger: "2.0", info: { title: "x", version: "1" }, paths: {} }), "utf8");
    const created = stubClient({ "POST /apis/import": { api: { id: "a" }, summary: {}, warnings: [] } });
    const result = await COMMANDS.import(created, { file, protocol: "REST" });
    assert.equal(result.data.api.id, "a");
    assert.equal(created.calls[0].path, "/apis/import");

    const merged = stubClient({ "PUT /apis/a/import": { apiId: "a", mode: "merge", summary: {}, warnings: [] } });
    const result2 = await COMMANDS.import(merged, { file, api: "a", mode: "merge" });
    assert.equal(result2.data.mode, "merge");
    await assert.rejects(COMMANDS.import(created, {}), (error) => error.exitCode === 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("S13: CLI export hits stage vs draft endpoints and writes --out files", async () => {
  const dir = join(tmpdir(), `pods-s13-${Date.now()}-out`);
  await mkdir(dir, { recursive: true });
  try {
    const client = stubClient({
      "GET /apis/a/stages/prod/export": { format: "json", document: { openapi: "3.0.3" } },
      "GET /apis/a/export": { format: "yaml", document: "openapi: 3.0.3\n" },
    });
    const stage = await COMMANDS.export(client, { api: "a", stage: "prod", type: "oas30" });
    assert.equal(stage.data.document.openapi, "3.0.3");
    const out = join(dir, "api.yaml");
    const written = await COMMANDS.export(client, { api: "a", source: "draft", out });
    assert.equal(written.data.written, out);
    assert.match(await readFile(out, "utf8"), /openapi/);
    await assert.rejects(COMMANDS.export(client, {}), (error) => error.exitCode === 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
