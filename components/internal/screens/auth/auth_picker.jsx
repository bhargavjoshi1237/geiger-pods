"use client";

// Method/route auth picker (S07 §8). Mounted on the S03 method panel
// (REST methods) and the routes tab (HTTP/WebSocket routes): type,
// authorizer, scopes and API-key-required. Persists through the existing
// method/route PATCH endpoints; capability gating hides JWT on WebSocket and
// the key toggle where the control plane rejects it (HTTP routes).

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { EmptyState, SectionCard } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { fetchApis } from "../apis/api_list";
import { authorizerTypesFor } from "@/lib/workspace/auth-ui.mjs";

const TYPES = ["NONE", "SIGNED", "JWT", "CUSTOM"];

/**
 * Loads the API's authorizers for the picker dropdown.
 *
 * @param {string} projectId - Workspace project id.
 * @param {string} apiRef - API public id or uuid.
 * @returns {Promise<Array<object>>} Authorizer views.
 */
async function loadAuthorizers(projectId, apiRef) {
  const data = await fetchApis(projectId, `/${encodeURIComponent(apiRef)}/authorizers?limit=100`);
  return data.items ?? [];
}

/**
 * Shared auth form state.
 */
function useAuthForm(target) {
  const [type, setType] = useState(target.authorizationType ?? "NONE");
  const [authorizerId, setAuthorizerId] = useState(target.authorizerId ?? "");
  const [scopesText, setScopesText] = useState((target.authorizationScopes ?? []).join(" "));
  const [apiKeyRequired, setApiKeyRequired] = useState(Boolean(target.apiKeyRequired));
  return { type, setType, authorizerId, setAuthorizerId, scopesText, setScopesText, apiKeyRequired, setApiKeyRequired };
}

function AuthFields({ form, authorizers, protocol, keyAllowed, disabled }) {
  const creatable = authorizerTypesFor(protocol);
  const visible = authorizers.filter((entry) => creatable.includes(entry.type));
  return <div className="grid gap-3">
    <div className="space-y-2">
      <Label>Authorization type</Label>
      <Select value={form.type} onValueChange={form.setType} disabled={disabled}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          {TYPES.filter((entry) => entry !== "JWT" || creatable.includes("JWT")).map((entry) => <SelectItem key={entry} value={entry}>{entry}</SelectItem>)}
        </SelectContent>
      </Select>
      {form.type === "SIGNED" ? <p className="text-xs text-muted-foreground">SigV4-signed requests with a project signing credential (IAM equivalent).</p> : null}
    </div>
    {(form.type === "JWT" || form.type === "CUSTOM") ? <div className="space-y-2">
      <Label>Authorizer</Label>
      <Select value={form.authorizerId} onValueChange={form.setAuthorizerId} disabled={disabled}>
        <SelectTrigger><SelectValue placeholder={visible.length === 0 ? "No authorizers yet — create one on the Authorizers tab" : "Pick an authorizer"} /></SelectTrigger>
        <SelectContent>{visible.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.name} ({entry.type})</SelectItem>)}</SelectContent>
      </Select>
    </div> : null}
    {form.type === "JWT" ? <div className="space-y-2">
      <Label htmlFor="auth-scopes">Scopes (space-separated, at least one must match)</Label>
      <Input id="auth-scopes" value={form.scopesText} onChange={(event) => form.setScopesText(event.target.value)} placeholder="read:pets write:pets" disabled={disabled} spellCheck={false} />
    </div> : null}
    {keyAllowed ? <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={form.apiKeyRequired} onChange={(event) => form.setApiKeyRequired(event.target.checked)} disabled={disabled} />
      API key required
    </label> : <p className="text-xs text-muted-foreground">API keys are enforced on REST methods and WebSocket routes only.</p>}
  </div>;
}

/**
 * Auth picker for one REST method. Saves via PATCH
 * `.../resources/:resourceId/methods/:httpMethod`.
 */
export function MethodAuthPicker({ api, resourceId, method, onSaved }) {
  const { project } = useProject();
  const { can } = useRbac();
  const apiRef = api.publicId ?? api.id;
  const [authorizers, setAuthorizers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const form = useAuthForm(method);
  const writable = can("pods.route.write");

  useEffect(() => {
    let alive = true;
    loadAuthorizers(project.id, apiRef).then(
      (items) => { if (alive) { setAuthorizers(items); setLoading(false); } },
      () => { if (alive) { setAuthorizers([]); setLoading(false); } },
    );
    return () => { alive = false; };
  }, [project.id, apiRef]);

  if (loading) return <SectionCard><div className="flex justify-center py-6"><LogoLoading /></div></SectionCard>;

  const save = async () => {
    const scopes = form.scopesText.split(/\s+/).map((scope) => scope.trim()).filter(Boolean);
    if ((form.type === "JWT" || form.type === "CUSTOM") && !form.authorizerId) {
      toast.error("Pick an authorizer for this type, or use NONE.");
      return;
    }
    setBusy(true);
    try {
      const saved = await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/resources/${encodeURIComponent(resourceId)}/methods/${encodeURIComponent(method.httpMethod)}`, {
        method: "PATCH",
        headers: { "If-Match": String(method.version) },
        body: JSON.stringify({
          authorizationType: form.type,
          authorizerId: form.authorizerId || null,
          authorizationScopes: scopes,
          apiKeyRequired: form.apiKeyRequired,
        }),
      });
      toast.success(`Saved auth for ${method.httpMethod}.`);
      onSaved?.(saved);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <SectionCard title="Authorization" description="Type, authorizer, scopes and API-key requirement for this method.">
    <AuthFields form={form} authorizers={authorizers} protocol={api.protocol} keyAllowed disabled={!writable || busy} />
    {writable ? <div className="pt-3"><Button size="sm" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save authorization"}</Button></div> : <p className="pt-3 text-xs text-muted-foreground">Read-only: your team access does not include route changes.</p>}
  </SectionCard>;
}

/**
 * Auth picker for one HTTP/WebSocket route. Saves via PATCH
 * `.../routes/:routeId`. The key toggle is hidden because the control plane
 * rejects `apiKeyRequired` on non-WebSocket routes.
 */
export function RouteAuthPicker({ api, route, onSaved }) {
  const { project } = useProject();
  const { can } = useRbac();
  const apiRef = api.publicId ?? api.id;
  const [authorizers, setAuthorizers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const form = useAuthForm(route);
  const writable = can("pods.route.write");
  const keyAllowed = api.protocol === "WEBSOCKET";

  useEffect(() => {
    let alive = true;
    loadAuthorizers(project.id, apiRef).then(
      (items) => { if (alive) { setAuthorizers(items); setLoading(false); } },
      () => { if (alive) { setAuthorizers([]); setLoading(false); } },
    );
    return () => { alive = false; };
  }, [project.id, apiRef]);

  if (loading) return <div className="flex justify-center py-4"><LogoLoading /></div>;

  const save = async () => {
    const scopes = form.scopesText.split(/\s+/).map((scope) => scope.trim()).filter(Boolean);
    if ((form.type === "JWT" || form.type === "CUSTOM") && !form.authorizerId) {
      toast.error("Pick an authorizer for this type, or use NONE.");
      return;
    }
    setBusy(true);
    try {
      const saved = await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/routes/${encodeURIComponent(route.id)}`, {
        method: "PATCH",
        headers: { "If-Match": String(route.version) },
        body: JSON.stringify({
          authorizationType: form.type,
          authorizerId: form.authorizerId || null,
          authorizationScopes: scopes,
          ...(keyAllowed ? { apiKeyRequired: form.apiKeyRequired } : {}),
        }),
      });
      toast.success(`Saved auth for ${route.routeKey}.`);
      onSaved?.(saved);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <div className="space-y-3 border-t border-border pt-3">
    <p className="flex items-center gap-2 text-xs font-medium"><ShieldCheck className="size-4" />Authorization — {route.routeKey}</p>
    <AuthFields form={form} authorizers={authorizers} protocol={api.protocol} keyAllowed={keyAllowed} disabled={!writable || busy} />
    {writable ? <Button variant="outline" size="sm" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save authorization"}</Button> : <EmptyState icon={ShieldCheck} title="Read-only" description="Your team access does not include route changes." />}
  </div>;
}
