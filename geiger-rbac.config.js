import { defineRbacConfig, defineRole } from "@geiger/rbac";
import { SECTIONS } from "./lib/workspace/model.mjs";

const permissions = SECTIONS.map((section) => ({
  key: `pods.${section}.view`, label: `View ${section}`, group: "Workspace views",
}));

export default defineRbacConfig({
  product: "pods",
  permissions,
  systemRoles: ["owner", "admin", "manager", "member"].map((key) => defineRole({
    key, name: key[0].toUpperCase() + key.slice(1),
    description: "Inherited suite access for the read-only Pods foundation.",
    permissions: permissions.map((p) => p.key),
  })),
});
