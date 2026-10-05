/**
 * AWS service integrations (S04 §3.5, P2).
 *
 * REST: `aws = {service, region, action|path}` → path- or action-style request,
 * SigV4-signed with the secret's credentials. HTTP APIs: first-class subtypes
 * with a parameter table (required/optional) copied from the AWS reference;
 * request parameters map onto subtype params.
 *
 * Kept deliberately simple but correct: each subtype knows its service,
 * endpoint, protocol (query vs JSON with `X-Amz-Target`) and parameter table.
 *
 * Config problems (unknown subtype, missing params/region/service) throw
 * `API_CONFIGURATION_ERROR` so the dispatcher renders 500, not 504.
 *
 * @module lib/gateway/core/integrations/aws
 */

import { GatewayError } from "../errors.mjs";

/**
 * First-class HTTP subtype table. `protocol: "query"` sends an
 * `application/x-www-form-urlencoded` body with `Action`/`Version`;
 * `protocol: "json"` sends JSON with an `X-Amz-Target` header.
 */
export const AWS_SUBTYPES = {
  "SQS-SendMessage": {
    service: "sqs",
    protocol: "query",
    version: "2012-11-05",
    action: "SendMessage",
    required: ["QueueUrl", "MessageBody"],
    optional: ["DelaySeconds", "MessageGroupId", "MessageDeduplicationId"],
  },
  "SQS-ReceiveMessage": {
    service: "sqs",
    protocol: "query",
    version: "2012-11-05",
    action: "ReceiveMessage",
    required: ["QueueUrl"],
    optional: ["MaxNumberOfMessages", "VisibilityTimeout", "WaitTimeSeconds"],
  },
  "SQS-DeleteMessage": {
    service: "sqs",
    protocol: "query",
    version: "2012-11-05",
    action: "DeleteMessage",
    required: ["QueueUrl", "ReceiptHandle"],
    optional: [],
  },
  "SQS-PurgeQueue": {
    service: "sqs",
    protocol: "query",
    version: "2012-11-05",
    action: "PurgeQueue",
    required: ["QueueUrl"],
    optional: [],
  },
  "EventBridge-PutEvents": {
    service: "events",
    protocol: "json",
    target: "AWSEvents.PutEvents",
    required: ["Entries"],
    optional: [],
  },
  "Kinesis-PutRecord": {
    service: "kinesis",
    protocol: "json",
    target: "Kinesis_20131202.PutRecord",
    required: ["StreamName", "Data", "PartitionKey"],
    optional: ["SequenceNumberForOrdering"],
  },
  "StepFunctions-StartExecution": {
    service: "states",
    protocol: "json",
    target: "AWSStepFunctions.StartExecution",
    required: ["StateMachineArn"],
    optional: ["Name", "Input"],
  },
  "StepFunctions-StartSyncExecution": {
    service: "states",
    protocol: "json",
    target: "AWSStepFunctions.StartSyncExecution",
    required: ["StateMachineArn"],
    optional: ["Name", "Input"],
  },
  "StepFunctions-StopExecution": {
    service: "states",
    protocol: "json",
    target: "AWSStepFunctions.StopExecution",
    required: ["ExecutionArn"],
    optional: ["Error", "Cause"],
  },
  "AppConfig-GetConfiguration": {
    service: "appconfig",
    protocol: "rest",
    method: "GET",
    path: "/applications/{Application}/environments/{Environment}/configurations/{Configuration}",
    required: ["Application", "Environment", "Configuration"],
    optional: [],
  },
};

/**
 * Validates subtype params against the table. Throws `API_CONFIGURATION_ERROR`
 * on missing required params or unknown subtypes.
 *
 * @param {string} subtype
 * @param {Record<string, unknown>} params
 * @returns {{ service: string }} The subtype entry.
 */
export function validateSubtypeParams(subtype, params) {
  const entry = AWS_SUBTYPES[subtype];
  if (!entry) {
    throw new GatewayError("API_CONFIGURATION_ERROR", "Internal server error", {
      reason: "unknown-subtype",
      message: `Unknown AWS subtype "${subtype}".`,
    });
  }
  const missing = (entry.required ?? []).filter((name) => params?.[name] === undefined || params?.[name] === null || params?.[name] === "");
  if (missing.length > 0) {
    throw new GatewayError("API_CONFIGURATION_ERROR", "Internal server error", {
      reason: "missing-params",
      message: `Missing required parameters: ${missing.join(", ")}.`,
      missing,
    });
  }
  return entry;
}

/**
 * Builds an unsigned AWS service request for a first-class subtype.
 *
 * @param {string} subtype - e.g. `"SQS-SendMessage"`.
 * @param {Record<string, unknown>} params - Mapped request parameters.
 * @param {{ region: string }} opts
 * @returns {{ method: string, url: string, headers: Record<string,string>, body: string | null, service: string }}
 */
export function buildSubtypeRequest(subtype, params, opts) {
  const entry = validateSubtypeParams(subtype, params ?? {});
  const region = opts?.region;
  if (!region) throw new GatewayError("API_CONFIGURATION_ERROR", "Internal server error", { reason: "missing-region" });
  const host = `${entry.service}.${region}.amazonaws.com`;
  if (entry.protocol === "query") {
    const form = new URLSearchParams({ Action: entry.action, Version: entry.version });
    for (const name of [...(entry.required ?? []), ...(entry.optional ?? [])]) {
      if (params[name] !== undefined && params[name] !== null) form.set(name, String(params[name]));
    }
    return {
      method: "POST",
      url: `https://${host}/`,
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: form.toString(),
      service: entry.service,
    };
  }
  if (entry.protocol === "json") {
    const payload = {};
    for (const name of [...(entry.required ?? []), ...(entry.optional ?? [])]) {
      if (params[name] !== undefined && params[name] !== null) payload[name] = params[name];
    }
    return {
      method: "POST",
      url: `https://${host}/`,
      headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": entry.target },
      body: JSON.stringify(payload),
      service: entry.service,
    };
  }
  // protocol "rest" (AppConfig-GetConfiguration): path-style with placeholders.
  let path = entry.path;
  for (const name of [...(entry.required ?? []), ...(entry.optional ?? [])]) {
    path = path.replace(`{${name}}`, encodeURIComponent(String(params[name] ?? "")));
  }
  return {
    method: entry.method ?? "GET",
    url: `https://${host}${path}`,
    headers: {},
    body: null,
    service: entry.service,
  };
}

/**
 * Builds an unsigned generic REST `AWS` integration request:
 * `{service, region, action}` → query-protocol POST, or `{path}` → path-style.
 *
 * @param {{ service: string, region: string, action?: string | null, path?: string | null, parameters?: Record<string, unknown> }} aws
 * @returns {{ method: string, url: string, headers: Record<string,string>, body: string | null, service: string }}
 */
export function buildRestAwsRequest(aws) {
  const { service, region, action = null, path = null, parameters = {} } = aws ?? {};
  if (!service || !region) {
    throw new GatewayError("API_CONFIGURATION_ERROR", "Internal server error", { reason: "missing-service" });
  }
  const host = `${service}.${region}.amazonaws.com`;
  if (path) {
    const url = new URL(path.startsWith("http") ? path : `https://${host}${path.startsWith("/") ? "" : "/"}${path}`);
    for (const [name, value] of Object.entries(parameters ?? {})) url.searchParams.set(name, String(value));
    return { method: "POST", url: url.toString(), headers: {}, body: null, service };
  }
  const form = new URLSearchParams({ Action: String(action), Version: "2012-11-05" });
  for (const [name, value] of Object.entries(parameters ?? {})) form.set(name, String(value));
  return {
    method: "POST",
    url: `https://${host}/`,
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: form.toString(),
    service,
  };
}
