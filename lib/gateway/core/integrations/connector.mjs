/**
 * Pods Connector tunnel: gateway-side hub plus the shared frame codec
 * (S04 §4, VPC-link equivalent). The agent (`connector/agent.mjs`) dials OUT
 * to the gateway runtime, so no inbound firewall rules are needed.
 *
 * Frames over one WebSocket per agent:
 * - control frames: JSON text (`hello`, `hello-ack`, `ping`, `pong`,
 *   `open{streamId,method,url,headers}`, `response-head{streamId,status,headers}`,
 *   `credit{streamId,bytes}`, `end{streamId}`, `close{streamId,status?}`,
 *   `error{streamId,message}`);
 * - data frames: binary, 4-byte big-endian streamId prefix + payload chunk.
 *
 * Per-stream credit-based flow control with a 256 KB window: a sender may
 * have at most `WINDOW_BYTES` unacknowledged bytes outstanding; the receiver
 * replenishes with `credit` frames as it consumes.
 *
 * @module lib/gateway/core/integrations/connector
 */

/** Per-stream flow-control window: 256 KB (spec §4). */
export const WINDOW_BYTES = 256 * 1024;

/** Max payload per data frame. */
export const CHUNK_BYTES = 64 * 1024;

/** Missed 10 s pings before an agent is marked dead. */
export const DEAD_AFTER_MISSED = 3;

/** Default ping interval: 10 s. */
export const PING_INTERVAL_MS = 10_000;

/** No agent seen for 5 min → FAILED. */
export const FAILED_AFTER_MS = 5 * 60 * 1000;

/**
 * Encodes a binary data frame: 4-byte BE streamId + payload.
 *
 * @param {number} streamId
 * @param {Uint8Array} payload
 * @returns {Buffer}
 */
export function encodeDataFrame(streamId, payload) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(streamId >>> 0, 0);
  return Buffer.concat([header, Buffer.from(payload)]);
}

/**
 * Decodes a binary data frame.
 *
 * @param {Buffer | Uint8Array} frame
 * @returns {{ streamId: number, payload: Buffer }}
 */
export function decodeDataFrame(frame) {
  const buf = Buffer.from(frame);
  if (buf.byteLength < 4) throw new Error("Short connector data frame.");
  return { streamId: buf.readUInt32BE(0), payload: buf.subarray(4) };
}

/**
 * Parses an `allowed_targets` entry: `host:port` or `CIDR:port`.
 *
 * @param {string} entry
 * @returns {{ host: string, cidr: { base: number, bits: number } | null, port: string } | null}
 */
export function parseTargetEntry(entry) {
  const text = String(entry ?? "").trim();
  const match = text.match(/^(.*):(\*|\d{1,5})$/);
  if (!match) return null;
  const host = match[1].replace(/^\[|\]$/g, "");
  const port = match[2];
  let cidr = null;
  if (host.includes("/")) {
    const [baseText, bitsText] = host.split("/");
    const bytes = baseText.split(".").map(Number);
    const bits = Number(bitsText);
    if (bytes.length !== 4 || bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return null;
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
    const base = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
    cidr = { base, bits };
  }
  return { host: host.toLowerCase(), cidr, port };
}

function ipv4ToInt(text) {
  const bytes = String(text).split(".").map(Number);
  if (bytes.length !== 4 || bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return null;
  return ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
}

/**
 * Checks a private target URL against an allow-list. The gateway checks this
 * before opening a stream; the agent enforces it locally as well.
 *
 * @param {string[]} allowedTargets - `host:port` or `CIDR:port` entries.
 * @param {string} targetUrl - Private URL, e.g. `http://orders.internal:8080/x`.
 * @returns {boolean}
 */
export function isTargetAllowed(allowedTargets, targetUrl) {
  let url;
  try {
    url = new URL(targetUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  for (const entry of allowedTargets ?? []) {
    const parsed = parseTargetEntry(entry);
    if (!parsed) continue;
    if (parsed.port !== "*" && parsed.port !== port) continue;
    if (parsed.cidr) {
      const addr = ipv4ToInt(host);
      if (addr === null) continue;
      const mask = parsed.cidr.bits === 0 ? 0 : (0xffffffff << (32 - parsed.cidr.bits)) >>> 0;
      if (((addr & mask) >>> 0) === ((parsed.cidr.base & mask) >>> 0)) return true;
    } else if (parsed.host === host) {
      return true;
    }
  }
  return false;
}

/**
 * Creates a gateway-side connector hub: agent registry, round-robin picking,
 * stream multiplexing, health accounting.
 *
 * @param {{ pingIntervalMs?: number, failedAfterMs?: number, now?: () => number, sendPing?: boolean }} [opts={}]
 * @returns {object} Hub with `attachSocket`, `invoke`, `status`, `agentCount`, `close`.
 */
export function createHub(opts = {}) {
  const now = opts.now ?? (() => Date.now());
  const failedAfterMs = opts.failedAfterMs ?? FAILED_AFTER_MS;
  /** @type {Map<string, Array<object>>} connectorId -> agents */
  const agents = new Map();
  /** @type {Map<number, object>} streamId -> pending invocation */
  const pending = new Map();
  /** @type {Map<string, number>} connectorId -> round-robin cursor */
  const cursors = new Map();
  let nextStreamId = 1;
  let pingTimer = null;
  let seq = 0;

  function liveAgents(connectorId) {
    return (agents.get(connectorId) ?? []).filter((agent) => agent.open && agent.missed < DEAD_AFTER_MISSED);
  }

  function send(agent, frame) {
    try {
      agent.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
    } catch {
      agent.open = false;
    }
  }

  function sendData(agent, streamId, payload) {
    try {
      agent.ws.send(encodeDataFrame(streamId, payload));
    } catch {
      agent.open = false;
    }
  }

  function onControl(agent, msg) {
    agent.lastSeen = now();
    if (msg.type === "pong") {
      agent.missed = 0;
      return;
    }
    if (msg.type === "credit" && pending.has(msg.streamId)) {
      const stream = pending.get(msg.streamId);
      stream.window += Number(msg.bytes) || 0;
      pumpRequestBody(agent, stream);
      return;
    }
    const stream = pending.get(msg.streamId);
    if (!stream) return;
    if (msg.type === "response-head") {
      stream.status = msg.status;
      stream.headers = new Headers(msg.headers ?? {});
    } else if (msg.type === "error") {
      stream.failed = new Error(String(msg.message ?? "Connector stream error."));
      stream.doneResolve?.();
    } else if (msg.type === "end" || msg.type === "close") {
      stream.ended = true;
      stream.doneResolve?.();
    }
  }

  function onData(agent, streamId, payload) {
    const stream = pending.get(streamId);
    if (!stream) return;
    agent.lastSeen = now();
    stream.chunks.push(Buffer.from(payload));
    stream.received += payload.byteLength;
    // Replenish the agent's send window as we consume.
    send(agent, { type: "credit", streamId, bytes: payload.byteLength });
    if (stream.received > stream.maxBytes) {
      stream.failed = Object.assign(new Error("Upstream response exceeded 10 MB."), { code: "response-too-large" });
      send(agent, { type: "close", streamId });
      stream.doneResolve?.();
    }
  }

  function pumpRequestBody(agent, stream) {
    while (stream.offset < stream.body.length && stream.window > 0 && !stream.failed) {
      const end = Math.min(stream.body.length, stream.offset + Math.min(CHUNK_BYTES, stream.window));
      sendData(agent, stream.streamId, stream.body.subarray(stream.offset, end));
      stream.window -= end - stream.offset;
      stream.offset = end;
    }
    if (stream.offset >= stream.body.length && !stream.bodyEndSent) {
      stream.bodyEndSent = true;
      send(agent, { type: "end", streamId: stream.streamId, direction: "request" });
    }
  }

  const hub = {
    WINDOW_BYTES,

    attachSocket(ws, { connectorId, agentId = null, allowedTargets = [] } = {}) {
      const agent = {
        ws,
        connectorId,
        agentId: agentId ?? `agent-${(seq += 1)}`,
        allowedTargets: [...allowedTargets],
        lastSeen: now(),
        missed: 0,
        open: true,
      };
      if (!agents.has(connectorId)) agents.set(connectorId, []);
      agents.get(connectorId).push(agent);
      try {
        ws.on?.("error", () => {
          agent.open = false;
        });
        // NOTE: the `ws` package delivers text frames as Buffer with
        // `isBinary === false`; only `isBinary === true` is a data frame.
        ws.on?.("message", (data, isBinary) => {
          const text = typeof data === "string"
            ? data
            : (isBinary === false || isBinary === undefined) && Buffer.isBuffer(data)
              ? data.toString("utf8")
              : null;
          if (text !== null) {
            let msg;
            try {
              msg = JSON.parse(text);
            } catch {
              return;
            }
            onControl(agent, msg);
          } else {
            try {
              const { streamId, payload } = decodeDataFrame(data);
              onData(agent, streamId, payload);
            } catch {
              // Ignore malformed frames; the stream times out.
            }
          }
        });
        ws.on?.("close", () => {
          agent.open = false;
        });
      } catch {
        // Non-EventEmitter sockets (tests) drive messages via hub.receive().
      }
      send(agent, { type: "hello-ack", agentId: agent.agentId });
      return agent;
    },

    /** Test seam: deliver one raw message to an agent as if from its socket. */
    receive(agent, data) {
      if (typeof data === "string") onControl(agent, JSON.parse(data));
      else {
        const { streamId, payload } = decodeDataFrame(Buffer.from(data));
        onData(agent, streamId, payload);
      }
    },

    pickAgent(connectorId) {
      const live = liveAgents(connectorId);
      if (live.length === 0) return null;
      const cursor = (cursors.get(connectorId) ?? 0) % live.length;
      cursors.set(connectorId, cursor + 1);
      return live[cursor];
    },

    agentCount(connectorId) {
      return liveAgents(connectorId).length;
    },

    lastSeenAt(connectorId) {
      const list = agents.get(connectorId) ?? [];
      if (list.length === 0) return null;
      return Math.max(...list.map((agent) => agent.lastSeen));
    },

    /**
     * Connector status: AVAILABLE (≥1 healthy agent), DEGRADED (some lost),
     * FAILED (none seen for 5 min), else PENDING.
     */
    status(connectorId, at = now()) {
      const list = agents.get(connectorId) ?? [];
      if (list.length === 0) return { status: "PENDING", agentCount: 0, lastSeenAt: null };
      const live = list.filter((agent) => agent.open && agent.missed < DEAD_AFTER_MISSED);
      const lastSeenAt = Math.max(...list.map((agent) => agent.lastSeen));
      if (live.length > 0) {
        const lost = list.length - live.length;
        return { status: lost > 0 ? "DEGRADED" : "AVAILABLE", agentCount: live.length, lastSeenAt };
      }
      if (at - lastSeenAt > failedAfterMs) {
        return { status: "FAILED", agentCount: 0, lastSeenAt };
      }
      return { status: "DEGRADED", agentCount: 0, lastSeenAt };
    },

    /** Ages agents: call per ping tick (or drive manually in tests). */
    tick() {
      for (const list of agents.values()) {
        for (const agent of list) {
          if (!agent.open) continue;
          agent.missed += 1;
          if (agent.missed < DEAD_AFTER_MISSED) send(agent, { type: "ping", id: agent.missed });
        }
      }
    },

    /**
     * Invokes a private URL through the tunnel (round-robin over healthy agents).
     *
     * @param {string} connectorId
     * @param {{ method: string, url: string, headers?: Headers | Record<string,string>, body?: Uint8Array | null }} outbound
     * @param {{ timeoutMs?: number, maxBytes?: number, connectorTargets?: string[] }} [opts={}]
     */
    async invoke(connectorId, outbound, opts = {}) {
      const agent = hub.pickAgent(connectorId);
      if (!agent) {
        throw Object.assign(new Error(`No healthy agents for connector "${connectorId}".`), {
          code: "no-agents",
        });
      }
      const targets = opts.connectorTargets ?? agent.allowedTargets ?? [];
      if (!isTargetAllowed(targets, outbound.url)) {
        throw Object.assign(new Error(`Target not in connector allow-list.`), { code: "target-not-allowed" });
      }
      const streamId = nextStreamId++;
      const body = outbound.body ? Buffer.from(outbound.body) : Buffer.alloc(0);
      const headers = outbound.headers instanceof Headers
        ? Object.fromEntries(outbound.headers.entries())
        : { ...(outbound.headers ?? {}) };
      const stream = {
        streamId,
        status: 0,
        headers: new Headers(),
        chunks: [],
        received: 0,
        maxBytes: opts.maxBytes ?? 10 * 1024 * 1024,
        offset: 0,
        body,
        window: WINDOW_BYTES,
        bodyEndSent: body.length === 0,
        ended: false,
        failed: null,
        doneResolve: null,
      };
      pending.set(streamId, stream);
      const timeoutMs = opts.timeoutMs ?? 29000;
      let timer;
      const done = new Promise((resolve) => {
        stream.doneResolve = resolve;
      });
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          stream.failed = Object.assign(new Error("Endpoint request timed out"), { code: "timeout" });
          try {
            agent.ws.send(JSON.stringify({ type: "close", streamId }));
          } catch { /* agent already gone */ }
          stream.doneResolve?.();
          reject(stream.failed);
        }, timeoutMs);
      });
      send(agent, { type: "open", streamId, method: outbound.method, url: outbound.url, headers });
      pumpRequestBody(agent, stream);
      if (body.length === 0) send(agent, { type: "end", streamId, direction: "request" });
      try {
        await Promise.race([done, timeout]);
      } finally {
        clearTimeout(timer);
        pending.delete(streamId);
      }
      if (stream.failed) throw stream.failed;
      if (!stream.ended) {
        throw Object.assign(new Error("Connector stream closed without end frame."), { code: "protocol" });
      }
      return {
        status: stream.status,
        headers: stream.headers,
        body: Buffer.concat(stream.chunks),
      };
    },

    close() {
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = null;
      for (const list of agents.values()) {
        for (const agent of list) {
          try {
            agent.ws.close?.();
          } catch { /* already closed */ }
        }
      }
      agents.clear();
      pending.clear();
    },
  };

  if (opts.sendPing) {
    pingTimer = setInterval(() => hub.tick(), opts.pingIntervalMs ?? PING_INTERVAL_MS);
    pingTimer.unref?.();
  }
  return hub;
}

/**
 * Gateway-side accept helper for the runtime (S05): waits for the agent's
 * `hello`, verifies the connector token, then attaches the socket to the hub.
 *
 * @param {object} hub - Created by `createHub`.
 * @param {object} ws - `ws`-package socket.
 * @param {{ lookupConnector: (token: string) => Promise<{ connectorId: string, allowedTargets: string[] } | null>, timeoutMs?: number }} opts
 * @returns {Promise<object>} The attached agent record.
 */
export async function acceptAgentSocket(hub, ws, opts) {
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const hello = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("Agent hello timeout."), { code: "hello-timeout" })), timeoutMs);
    const onMessage = async (data, isBinary) => {
      // `ws` delivers text frames as Buffer with `isBinary === false`.
      const text = typeof data === "string"
        ? data
        : (isBinary === false || isBinary === undefined) && Buffer.isBuffer(data)
          ? data.toString("utf8")
          : null;
      if (text === null) return;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg?.type !== "hello") return;
      clearTimeout(timer);
      ws.off?.("message", onMessage);
      resolve(msg);
    };
    ws.on?.("message", onMessage);
  });
  const connector = await opts.lookupConnector(String(hello.token ?? ""));
  if (!connector) {
    try {
      ws.send(JSON.stringify({ type: "error", streamId: 0, message: "Unknown or revoked connector token." }));
      ws.close?.(4001, "unauthorized");
    } catch { /* already gone */ }
    throw Object.assign(new Error("Unknown or revoked connector token."), { code: "unauthorized" });
  }
  return hub.attachSocket(ws, {
    connectorId: connector.connectorId,
    agentId: hello.agentId,
    allowedTargets: connector.allowedTargets ?? hello.allowedTargets ?? [],
  });
}
