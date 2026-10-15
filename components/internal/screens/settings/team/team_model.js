import { toast } from "sonner";
import rbacConfig from "@/geiger-rbac.config";

// Shared helpers for Settings → Team & Access. Pods has no member roster of its
// own — everyone inherits access from their Geiger team role — so a "member"
// here is a user holding at least one product role grant.

export async function api(projectId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

export const SYSTEM_ROLES = rbacConfig.systemRoles.map((role) => ({ key: role.key, name: role.name, description: role.description }));

export const GRANT_STATUS_MAP = {
  active: { label: "Active", variant: "success" },
  suspended: { label: "Suspended", variant: "warning" },
  revoked: { label: "Revoked", variant: "neutral" },
};

export const ACCESS_FILTER_OPTIONS = [
  { value: "all", label: "All Access" },
  { value: "project", label: "All APIs" },
  { value: "scoped", label: "Scoped to APIs" },
];

export const formatDate = (value) => (value ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");

export function formatRelativeTime(value) {
  if (!value) return "—";
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(value);
}

export const roleLabel = (grant) => grant.roleName ?? grant.roleKey ?? "Unknown role";
export const scopedApis = (grant) => grant.scope?.api ?? [];

export function copy(value, label) {
  navigator.clipboard?.writeText(value).then(
    () => toast.success(`${label} copied.`),
    () => toast.error(`Couldn't copy the ${label.toLowerCase()}.`),
  );
}

const STATUS_RANK = { active: 0, suspended: 1, revoked: 2 };

/** One row per user holding a grant, in the order they were first granted. */
export function membersFromGrants(grants) {
  const byUser = new Map();
  for (const grant of grants) {
    const member = byUser.get(grant.userId) ?? { userId: grant.userId, grants: [], since: null };
    member.grants.push(grant);
    if (grant.createdAt && (!member.since || grant.createdAt < member.since)) member.since = grant.createdAt;
    byUser.set(grant.userId, member);
  }
  return [...byUser.values()].map((member) => {
    const statuses = member.grants.map((grant) => grant.status ?? "active");
    const unscoped = member.grants.some((grant) => scopedApis(grant).length === 0);
    return {
      ...member,
      status: statuses.sort((a, b) => (STATUS_RANK[a] ?? 9) - (STATUS_RANK[b] ?? 9))[0] ?? "active",
      // Any project-wide grant reaches every API; otherwise the union of scopes.
      apis: unscoped ? null : [...new Set(member.grants.flatMap(scopedApis))],
    };
  });
}

export function accessLabel(apis) {
  if (!apis) return "All APIs";
  return `${apis.length} API${apis.length === 1 ? "" : "s"}`;
}
