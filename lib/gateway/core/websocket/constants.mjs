/**
 * WebSocket limits and close codes (S12 §2, AWS quotas).
 *
 * @module lib/gateway/core/websocket/constants
 */

/** Max reassembled message: 128 KB (close 1009 when exceeded). */
export const MAX_MESSAGE_BYTES = 128 * 1024;

/** Max single WebSocket frame: 32 KB (close 1009 when exceeded). */
export const MAX_FRAME_BYTES = 32 * 1024;

/** Idle timeout: 10 min without client frames (close 1001). Pings count. */
export const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** Max connection duration: 2 h (close 1001 `Going away`). */
export const MAX_DURATION_MS = 2 * 60 * 60 * 1000;

/** Server protocol ping interval: 30 s (dead-peer detection). */
export const PING_INTERVAL_MS = 30 * 1000;

/** Per-connection outbound queue cap: 1 MB (over → close 1008). */
export const OUTBOUND_QUEUE_MAX_BYTES = 1024 * 1024;

/** Cross-instance reply timeout: 5 s (→ 410 when gone, else 504). */
export const CROSS_INSTANCE_TIMEOUT_MS = 5000;

/** Instance heartbeat interval: 10 s with a 30 s TTL. */
export const INSTANCE_HEARTBEAT_MS = 10 * 1000;
export const INSTANCE_TTL_MS = 30 * 1000;

/** Connection registry TTL: max duration + 60 s. */
export const CONN_TTL_MS = MAX_DURATION_MS + 60 * 1000;

/** Graceful shutdown bounds: concurrency 50, total ≤ 20 s. */
export const SHUTDOWN_CONCURRENCY = 50;
export const SHUTDOWN_TIMEOUT_MS = 20 * 1000;

/** KV keys/channels. */
export const connKey = (connectionId) => `ws:conn:${connectionId}`;
export const instanceKey = (instanceId) => `ws:instance:${instanceId}`;
export const instanceChannel = (instanceId) => `ws:inst:${instanceId}`;
export const replyChannel = (nonce) => `ws:reply:${nonce}`;
