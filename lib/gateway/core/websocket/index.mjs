/**
 * WebSocket engine barrel (S12).
 *
 * @module lib/gateway/core/websocket/index
 */

export * from "./constants.mjs";
export * from "./selection.mjs";
export * from "./registry.mjs";
export * from "./events.mjs";
export * from "./validate.mjs";
export * from "./connect.mjs";
export * from "./message.mjs";
export * from "./connections-api.mjs";
export { createWebSocketManager } from "./manager.mjs";
