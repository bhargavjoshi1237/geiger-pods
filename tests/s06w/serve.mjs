/**
 * Runtime serve helper for S06W: serves a compiled artifact on the real
 * gateway server (`createGatewayServer` with an in-memory loader) with
 * path-based routing. Kept separate from `helper.mjs` so compile-only tests
 * never import the engine (other agents edit engine phases concurrently).
 *
 * @module tests/s06w/serve
 */

import { createMemoryLoader } from "../../gateway/loader.mjs";
import { createGatewayServer } from "../../gateway/server.mjs";
import { MemoryKvStore } from "../../lib/gateway/state/memory-kv.mjs";

process.env.PODS_ALLOW_LOOPBACK = "1";

/**
 * Serves one artifact on the real gateway server.
 *
 * @param {object} artifact - Compiled artifact.
 * @param {{ stage?: string, stageVariables?: object }} [options={}]
 * @returns {Promise<{ gateway: object, port: number, apiPublicId: string, baseUrl: string }>}
 */
export async function serveArtifact(artifact, options = {}) {
  const stage = options.stage ?? "$default";
  const kv = new MemoryKvStore({});
  const loader = createMemoryLoader({
    kv,
    pathRouting: true,
    stages: new Map([
      [`${artifact.apiPublicId}:${stage}`, {
        artifact,
        stageVariables: options.stageVariables ?? {},
      }],
    ]),
  });
  const gateway = createGatewayServer({ loader, ports: { kv } });
  const port = await gateway.start(0);
  const prefix = stage === "$default" ? "" : `/${stage}`;
  return {
    gateway,
    port,
    apiPublicId: artifact.apiPublicId,
    baseUrl: `http://127.0.0.1:${port}/${artifact.apiPublicId}${prefix}`,
  };
}
