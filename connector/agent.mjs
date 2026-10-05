/**
 * Pods Connector agent (S04 §4): dials OUT to the gateway runtime, so no
 * inbound firewall rules are needed. Run:
 * `node connector/agent.mjs --url wss://<gateway>/_connector --token pods_ctr_…`
 *
 * The agent authenticates with its connector token, enforces
 * `allowed_targets` locally (the gateway checks too), resolves DNS inside the
 * private network (covers internal DNS / Cloud Map equivalents), and relays
 * streams with the 256 KB credit window from `connector/PROTOCOL.md`.
 *
 * @module connector/agent
 */

import WebSocket from "ws";
import { CHUNK_BYTES, decodeDataFrame, encodeDataFrame, isTargetAllowed, WINDOW_BYTES } from "../lib/gateway/core/integrations/connector.mjs";

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[name] = next;
        index += 1;
      } else {
        out[name] = "1";
      }
    }
  }
  return out;
}

/**
 * Starts a connector agent.
 *
 * @param {{ url: string, token: string, allowedTargets?: string[], agentId?: string, fetchFn?: Function, reconnect?: boolean, reconnectDelayMs?: number, onEvent?: (event: object) => void }} opts
 * @returns {{ agentId: string, close(): Promise<void>, stats(): object, state(): string }}
 */
export async function startAgent(opts) {
  const {
    url,
    token,
    allowedTargets = [],
    agentId = `agent-${Math.random().toString(36).slice(2, 10)}`,
    fetchFn = globalThis.fetch,
    reconnect = true,
    reconnectDelayMs = 2000,
    onEvent = () => {},
  } = opts ?? {};
  if (!url || !token) throw new Error("startAgent requires url and token.");

  /** @type {Map<number, { window: number, resume: (() => void) | null, requestChunks: Buffer[], requestEndResolve: (() => void) | null, requestEnded: boolean }>} */
  const streams = new Map();
  let ws = null;
  let stopped = false;
  let currentState = "connecting";
  let reconnectAttempts = 0;
  let helloAcked = false;

  const emit = (event) => {
    try {
      onEvent({ agentId, ...event });
    } catch { /* observability never breaks the tunnel */ }
  };

  function send(frame) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  function getStream(streamId) {
    let stream = streams.get(streamId);
    if (!stream) {
      stream = { window: WINDOW_BYTES, resume: null, requestChunks: [], requestEndResolve: null, requestEnded: false };
      streams.set(streamId, stream);
    }
    return stream;
  }

  async function sendPayload(streamId, payload) {
    const stream = getStream(streamId);
    let offset = 0;
    while (offset < payload.byteLength) {
      while (stream.window <= 0) {
        await new Promise((resolve) => {
          stream.resume = resolve;
        });
      }
      const end = Math.min(payload.byteLength, offset + Math.min(CHUNK_BYTES, stream.window));
      if (ws?.readyState === WebSocket.OPEN) ws.send(encodeDataFrame(streamId, payload.subarray(offset, end)));
      stream.window -= end - offset;
      offset = end;
    }
  }

  async function serveStream(streamId, open) {
    if (!isTargetAllowed(allowedTargets, open.url)) {
      send({ type: "error", streamId, message: `Target not in connector allow-list.` });
      streams.delete(streamId);
      emit({ kind: "target-rejected", streamId, url: open.url });
      return;
    }
    const stream = getStream(streamId);
    // Wait for the full request body (bounded by the window the gateway honors).
    if (!stream.requestEnded) {
      await new Promise((resolve) => {
        stream.requestEndResolve = resolve;
      });
    }
    const body = Buffer.concat(stream.requestChunks);
    let upstream;
    try {
      upstream = await fetchFn(open.url, {
        method: open.method,
        headers: open.headers ?? {},
        body: body.length > 0 ? body : undefined,
        // Never follow redirects: the gateway allow-list checked the original
        // URL only, so a 302 to an unlisted host must be returned, not followed.
        redirect: "manual",
      });
    } catch (error) {
      send({ type: "error", streamId, message: `Private fetch failed: ${String(error?.message ?? error).slice(0, 200)}` });
      streams.delete(streamId);
      return;
    }
    const headers = {};
    upstream.headers?.forEach?.((value, name) => {
      headers[name] = value;
    });
    send({ type: "response-head", streamId, status: upstream.status, headers });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    await sendPayload(streamId, bytes);
    send({ type: "end", streamId, direction: "response" });
    streams.delete(streamId);
    emit({ kind: "stream-served", streamId, status: upstream.status });
  }

  function onControl(msg) {
    if (msg.type === "hello-ack") {
      helloAcked = true;
      emit({ kind: "hello-ack" });
      return;
    }
    if (msg.type === "ping") {
      send({ type: "pong", id: msg.id ?? null });
      return;
    }
    if (msg.type === "open") {
      void serveStream(msg.streamId, msg);
      return;
    }
    const stream = streams.get(msg.streamId);
    if (!stream) return;
    if (msg.type === "credit") {
      stream.window += Number(msg.bytes) || 0;
      stream.resume?.();
      stream.resume = null;
      return;
    }
    if ((msg.type === "end" && msg.direction !== "response") || msg.type === "close" || msg.type === "error") {
      stream.requestEnded = true;
      stream.requestEndResolve?.();
      stream.requestEndResolve = null;
      if (msg.type !== "end") {
        streams.delete(msg.streamId);
      }
    }
  }

  function connect() {
    if (stopped) return;
    currentState = "connecting";
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    ws = socket;
    socket.on("open", () => {
      currentState = "open";
      reconnectAttempts = 0;
      helloAcked = false;
      socket.send(JSON.stringify({ type: "hello", token, agentId, allowedTargets }));
      emit({ kind: "connected" });
    });
    socket.on("message", (data, isBinary) => {
      // `ws` delivers text frames as Buffer with `isBinary === false`.
      const text = typeof data === "string"
        ? data
        : (isBinary === false || isBinary === undefined) && Buffer.isBuffer(data)
          ? data.toString("utf8")
          : null;
      if (text === null) {
        try {
          const { streamId, payload } = decodeDataFrame(data);
          const stream = getStream(streamId);
          stream.requestChunks.push(Buffer.from(payload));
          // Replenish the gateway's send window as we consume.
          send({ type: "credit", streamId, bytes: payload.byteLength });
        } catch {
          // Ignore malformed frames; the stream times out gateway-side.
        }
        return;
      }
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      onControl(msg);
    });
    const scheduleReconnect = () => {
      if (stopped || !reconnect) return;
      currentState = "reconnecting";
      reconnectAttempts += 1;
      emit({ kind: "reconnecting", attempt: reconnectAttempts });
      setTimeout(connect, reconnectDelayMs);
    };
    socket.on("close", scheduleReconnect);
    socket.on("error", () => {
      try {
        socket.close();
      } catch { /* already closing */ }
    });
  }

  connect();
  // Wait briefly for the first connection so misconfigured URLs fail fast.
  await new Promise((resolve) => setTimeout(resolve, 50));

  return {
    agentId,
    state: () => currentState,
    stats: () => ({ reconnectAttempts, helloAcked, openStreams: streams.size }),
    async close() {
      stopped = true;
      currentState = "closed";
      try {
        ws?.close();
      } catch { /* already closed */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    },
  };
}

// CLI: `node connector/agent.mjs --url wss://… --token pods_ctr_… [--targets host:port,CIDR:port]`
const invokedAsCli = process.argv[1] !== undefined && process.argv[1].replace(/\\/g, "/").endsWith("connector/agent.mjs");
if (invokedAsCli) {
  const args = parseArgs(process.argv.slice(2));
  const targets = String(args.targets ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const handle = await startAgent({
    url: args.url,
    token: args.token,
    allowedTargets: targets,
    onEvent: (event) => console.log(`[connector-agent] ${event.kind}`),
  });
  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
