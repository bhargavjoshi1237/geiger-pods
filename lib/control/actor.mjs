// Who is calling the management API (S02 §4). Session cookies come from the
// parent Geiger suite; `Authorization: Bearer pods_pat_…` / `pods_svc_…`
// tokens are S14 (resolved via access-tokens.mjs when a control DB is given).

export const PAT_PREFIX = "pods_pat_";
export const SVC_PREFIX = "pods_svc_";

/**
 * Resolve the caller from a request.
 * @param {Request} request the incoming request.
 * @param {{ supabase?: object, controlDb?: object, tokenIp?: string|null }} [deps]
 * @returns {Promise<{ type: "user", userId: string } | { type: "token", tokenHint: string } | { type: "token", tokenId: string, projectId: string, userId: string|null, kind: string, scopes: Array<string>, name: string } | null>}
 */
export async function resolveActor(request, deps = {}) {
  const authorization = request.headers?.get?.("authorization") ?? "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  const looksLikeToken = (bearer.startsWith(PAT_PREFIX) || bearer.startsWith(SVC_PREFIX)) && bearer.length > 10;
  if (looksLikeToken) {
    if (deps.controlDb) {
      const { resolveToken } = await import("./access-tokens.mjs");
      const resolved = await resolveToken(deps.controlDb, bearer, { ip: deps.tokenIp ?? null });
      if (resolved) return resolved;
    }
    return { type: "token", tokenHint: bearer.slice(0, PAT_PREFIX.length + 4) };
  }
  if (!deps.supabase) return null;
  const { data, error } = await deps.supabase.auth.getUser();
  if (error || !data?.user?.id) return null;
  return { type: "user", userId: data.user.id };
}
