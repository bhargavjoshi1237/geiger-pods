#!/usr/bin/env node
// Runs the Pods data plane locally against the shared database, with path
// routing: http://localhost:4000/{apiPublicId}/{stage}/{path}.
// (gateway/server.mjs only self-starts when argv[1] ends with
// "gateway/server.mjs", which a Windows backslash path never does.)
//
//   node scripts/seed-anilist/gateway-local.mjs

import { loadEnv } from "./context.mjs";

loadEnv();
process.env.PODS_GATEWAY_PATH_ROUTING ??= "1";
process.env.PORT ??= "4000";
const { main } = await import("../../gateway/server.mjs");
await main();
