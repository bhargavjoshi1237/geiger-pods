// Shared helpers for the playground seed. Seed rows are raw DB rows (snake_case),
// exactly what Supabase would return, so every normalize*() in lib/supabase/*
// runs over them unchanged. Keep seed files free of "use client" and of React
// imports so the integrity test can load them in plain Node.

import { PLAYGROUND_PROJECT } from "../mode.js";

export const PROJECT_ID = PLAYGROUND_PROJECT.id;

// Stable, valid UUIDs per entity kind so cross-table references line up.
// EDIT PER APP: an 8-hex-digit app prefix and the kinds the seed uses.
// sid("api", 3) -> "d0e70001-0000-4000-8000-000000000003".
const APP_PREFIX = 0xd0e70000;
const KIND_CODES = {
  api: 1,
  rest_resource: 2,
  rest_method: 3,
  http_route: 4,
  integration: 5,
  integration_response: 6,
  route_response: 7,
  method_response: 8,
  deployment: 9,
  stage: 10,
  stage_history: 11,
  api_key: 12,
  usage_plan: 13,
  quota_adjustment: 14,
  connector: 15,
  connector_token: 16,
  client_certificate: 17,
  authorizer: 18,
  signing_credential: 19,
  signing_policy: 20,
  model: 21,
  request_validator: 22,
  gateway_response: 23,
  documentation_part: 24,
  documentation_version: 25,
  domain_name: 26,
  api_mapping: 27,
  routing_rule: 28,
  trust_store: 29,
  domain_access_association: 30,
  ip_set: 31,
  regex_set: 32,
  web_acl: 33,
  web_acl_association: 34,
  role: 35,
  role_grant: 36,
  project_setting: 37,
  audit_event: 38,
  secret: 39,
  secret_version: 40,
  access_token: 41,
  tag: 42,
  stack: 43,
  event_subscription: 44,
  event_delivery: 45,
  access_log: 46,
  execution_log: 47,
  trace_span: 48,
  notification_channel: 49,
  alarm: 50,
  alarm_history: 51,
  log_sink: 52,
  sampling_rule: 53,
  portal: 54,
  portal_product: 55,
  portal_product_link: 56,
  product_page: 57,
  product_endpoint_page: 58,
  portal_event: 59,
  sdk_job: 60,
  websocket_connection: 61,
};

export function sid(kind, n) {
  const code = KIND_CODES[kind];
  if (!code) throw new Error(`Unknown seed kind: ${kind}`);
  const prefix = (APP_PREFIX + code).toString(16).padStart(8, "0");
  return `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Everything is relative to page load so the demo never looks stale.
export function daysAgo(days, hours = 0) {
  return new Date(Date.now() - days * DAY - hours * HOUR).toISOString();
}

export function hoursAgo(hours) {
  return new Date(Date.now() - hours * HOUR).toISOString();
}

export function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

export function daysFromNow(days, hours = 0) {
  return new Date(Date.now() + days * DAY + hours * HOUR).toISOString();
}

export function dateOnly(iso) {
  return iso.slice(0, 10);
}

// Deterministic 0..1 pseudo-random from a number, so seeded data looks organic
// but is identical on every load.
export function noise(n) {
  const x = Math.sin(n * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

// Deterministic integer in [min, max].
export function between(n, min, max) {
  return Math.round(min + noise(n) * (max - min));
}

// Deterministic element of an array.
export function pick(arr, n) {
  return arr[Math.floor(noise(n) * arr.length) % arr.length];
}

// Deterministic weighted choice: weighted(7, [["paid", 8], ["refunded", 1]]).
export function weighted(n, pairs) {
  const total = pairs.reduce((sum, [, w]) => sum + w, 0);
  let roll = noise(n) * total;
  for (const [value, w] of pairs) {
    roll -= w;
    if (roll < 0) return value;
  }
  return pairs[pairs.length - 1][0];
}

// range(3, (i) => i * 2) -> [2, 4, 6]; i is 1-based so it doubles as sid n.
export function range(count, fn = (i) => i) {
  return Array.from({ length: count }, (_, i) => fn(i + 1));
}

// Base columns most project-owned rows carry. Drop or override what a table
// doesn't have.
export function base(kind, n, { created = 30, updated, ...rest } = {}) {
  return {
    id: sid(kind, n),
    project_id: PROJECT_ID,
    created_at: daysAgo(created),
    updated_at: daysAgo(updated ?? Math.max(0, created - 1)),
    ...rest,
  };
}
