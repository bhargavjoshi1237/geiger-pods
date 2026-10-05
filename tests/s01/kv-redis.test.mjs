import test from "node:test";

import { RedisKvStore } from "../../lib/gateway/state/redis-kv.mjs";
import { defineKvContract } from "./kv-contract.mjs";

const url = process.env.PODS_KV_URL;

if (!url) {
  test("S01: redis kv contract (skipped — PODS_KV_URL is not set)", (t) => {
    t.skip("PODS_KV_URL is not set; the redis contract needs a live Redis-protocol server.");
  });
} else {
  defineKvContract("redis", async () => {
    const kv = new RedisKvStore(url);
    await kv.connect();
    return kv;
  });
}
