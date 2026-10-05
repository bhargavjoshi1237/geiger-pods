import { defineRbacConfig, defineRole } from "@geiger/rbac";
import { SECTIONS, SECTION_TITLES } from "./lib/workspace/screens.mjs";

// S02 full permission catalog. Keys are `pods.<resource>.<action>`; API-level
// keys carry `scopeBy: "api"` so a grant can be narrowed to specific APIs.

const API_SCOPED = [
  ["route", "write", "Build", "Edit routes and methods"],
  ["integration", "write", "Build", "Edit integrations"],
  ["model", "write", "Build", "Edit models"],
  ["authorizer", "write", "Build", "Edit authorizers"],
  ["gateway_response", "write", "Build", "Edit gateway responses"],
  ["documentation", "write", "Build", "Edit documentation parts"],
  ["deployment", "create", "Release", "Create deployments"],
  ["stage", "write", "Release", "Edit stages"],
  ["stage", "promote", "Release", "Promote a deployment to a stage"],
  ["stage", "delete", "Release", "Delete stages"],
  ["cache", "flush", "Release", "Flush the stage cache"],
  ["test", "invoke", "Release", "Invoke test invocations"],
];

const PROJECT_SCOPED = [
  // [resource, action, group, label]
  // NOTE: `pods.usage.view` and `pods.audit.view` are declared once as the
  // workspace view keys for the usage and audit sections; they double as the
  // Consumers/Operations keys from the spec table (same key, one definition).
  ["api", "create", "APIs", "Create APIs"],
  ["api", "update", "APIs", "Edit APIs"],
  ["api", "delete", "APIs", "Delete APIs"],
  ["api", "import", "APIs", "Import APIs"],
  ["api", "export", "APIs", "Export APIs"],
  ["api_key", "write", "Consumers", "Manage API keys"],
  ["api_key", "reveal", "Consumers", "Reveal API key values"],
  ["usage_plan", "write", "Consumers", "Manage usage plans"],
  ["secret", "write", "Security", "Manage secrets"],
  ["secret", "use", "Security", "Reference secrets in configuration"],
  ["client_cert", "write", "Security", "Manage backend client certificates"],
  ["trust_store", "write", "Security", "Manage TLS trust stores"],
  ["waf", "write", "Security", "Manage WAF rules"],
  ["resource_policy", "write", "Security", "Edit resource policies"],
  ["domain", "write", "Network", "Manage custom domains"],
  ["connector", "write", "Network", "Manage private connectors"],
  ["logs", "view", "Operations", "View gateway logs"],
  ["logs", "data", "Operations", "View request and response bodies"],
  ["alarm", "write", "Operations", "Manage alarms"],
  ["export", "write", "Operations", "Export logs and data"],
  ["portal", "write", "Distribution", "Manage developer portals"],
  ["portal", "publish", "Distribution", "Publish developer portals"],
  ["sdk", "generate", "Distribution", "Generate SDKs"],
  ["connection", "manage", "WebSocket", "Manage WebSocket connections"],
  ["settings", "write", "Administration", "Edit project settings"],
  ["role", "grant", "Administration", "Grant product roles"],
  ["token", "write", "Administration", "Manage personal access tokens"],
];

const permissions = [
  ...SECTIONS.map((section) => ({
    key: `pods.${section}.view`,
    label: `View ${SECTION_TITLES[section] ?? section}`,
    group: "Workspace views",
  })),
  ...API_SCOPED.map(([resource, action, group, label]) => ({
    key: `pods.${resource}.${action}`, label, group, scopeBy: "api",
  })),
  ...PROJECT_SCOPED.map(([resource, action, group, label]) => ({
    key: `pods.${resource}.${action}`, label, group,
  })),
];

const permissionKeys = permissions.map((permission) => permission.key);
const viewKeys = SECTIONS.map((section) => `pods.${section}.view`);
const buildKeys = API_SCOPED.filter(([, , group]) => group === "Build").map(([resource, action]) => `pods.${resource}.${action}`);

export default defineRbacConfig({
  product: "pods",
  permissions,
  systemRoles: [
    defineRole({
      key: "owner",
      name: "Owner",
      description: "Full access to the project, including role grants.",
      permissions: ["*"],
    }),
    defineRole({
      key: "admin",
      name: "Admin",
      description: "Every Pods permission except granting roles.",
      permissions: permissionKeys.filter((key) => key !== "pods.role.grant"),
    }),
    defineRole({
      key: "manager",
      name: "Manager",
      description: "Builds, releases and consumer support without destructive or credential-revealing actions.",
      permissions: [
        ...viewKeys,
        ...buildKeys,
        "pods.deployment.create",
        "pods.stage.write",
        "pods.stage.promote",
        "pods.cache.flush",
        "pods.test.invoke",
        "pods.api_key.write",
        "pods.usage_plan.write",
        "pods.usage.view",
        "pods.logs.view",
        "pods.logs.data",
        "pods.audit.view",
        "pods.secret.use",
        "pods.portal.write",
      ],
    }),
    defineRole({
      key: "member",
      name: "Member",
      description: "Read-only workspace access plus usage and log viewing.",
      permissions: [...new Set([...viewKeys, "pods.logs.view"])],
    }),
  ],
});
