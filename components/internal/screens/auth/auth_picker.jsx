"use client";

// Method/route auth picker. Mounted on the REST method view and the routes
// tab (HTTP/WebSocket routes): type, authorizer, scopes and API-key-required.
// Persists through the method/route PATCH endpoints; capability gating hides
// JWT on WebSocket and the key toggle where the control plane rejects it
// (HTTP routes).

import { useEffect, useId, useState } from "react";
import { Loader2 } from "lucide-react";
import { Field, LoadingArea, SectionCard } from "@/components/internal/shared/screen_kit";
import { Button } from "@geiger/ui/button";
import { DialogFooter } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { Switch } from "@geiger/ui/switch";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { fetchApis } from "../apis/api_list";
import { authorizerTypesFor } from "@/lib/workspace/auth-ui.mjs";

const TYPES = ["NONE", "SIGNED", "JWT", "CUSTOM"];

const PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";
const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

const TYPE_LABEL = { NONE: "None (open)", SIGNED: "Signed requests (SigV4)", JWT: "JWT", CUSTOM: "Custom authorizer" };

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
  const baseId = useId();
  const typeId = `${baseId}-type`;
  const authorizerId = `${baseId}-authorizer`;
  const scopesId = `${baseId}-scopes`;
  const keyId = `${baseId}-key`;
  return <div className="space-y-4">
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Authorization type" htmlFor={typeId} hint={form.type === "SIGNED" ? "Requests must be SigV4-signed with a project signing credential." : undefined}>
        <Select value={form.type} onValueChange={form.setType} disabled={disabled}>
          <SelectTrigger id={typeId} className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            {TYPES.filter((entry) => entry !== "JWT" || creatable.includes("JWT")).map((entry) => <SelectItem key={entry} value={entry}>{TYPE_LABEL[entry] ?? entry}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
      {(form.type === "JWT" || form.type === "CUSTOM") ? <Field label="Authorizer" htmlFor={authorizerId} hint={visible.length === 0 ? "Create one in Authorizers first." : undefined}>
        <Select value={form.authorizerId} onValueChange={form.setAuthorizerId} disabled={disabled}>
          <SelectTrigger id={authorizerId} className="w-full"><SelectValue placeholder={visible.length === 0 ? "No authorizers yet" : "Pick an authorizer"} /></SelectTrigger>
          <SelectContent>{visible.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.name} ({entry.type})</SelectItem>)}</SelectContent>
        </Select>
      </Field> : null}
    </div>
    {form.type === "JWT" ? <Field label="Scopes" hint="Space separated. The token must carry at least one of them." htmlFor={scopesId}>
      <Input id={scopesId} value={form.scopesText} onChange={(event) => form.setScopesText(event.target.value)} placeholder="read:pets write:pets" disabled={disabled} spellCheck={false} className="font-mono" />
    </Field> : null}
    {keyAllowed ? <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
      <div className="min-w-0">
        <label htmlFor={keyId} className="text-sm font-medium text-foreground">API key required</label>
        <p className="text-xs text-text-secondary">Callers must also send a valid API key.</p>
      </div>
      <Switch id={keyId} checked={form.apiKeyRequired} onCheckedChange={(checked) => form.setApiKeyRequired(checked === true)} disabled={disabled} />
    </div> : <p className="border-t border-border pt-4 text-xs text-text-secondary">API keys are enforced on REST methods and WebSocket routes only.</p>}
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

  if (loading) return <LoadingArea label="Loading authorizers" />;

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

  return <SectionCard
    bare
    title="Authorization"
    description="Who may call this method: authorization type, authorizer, scopes and API key."
    action={writable ? <Button size="sm" className={PRIMARY} disabled={busy} onClick={save}>{busy ? "Saving…" : "Save Authorization"}</Button> : null}
  >
    <div className="rounded-xl border border-border bg-surface-card p-4">
      <AuthFields form={form} authorizers={authorizers} protocol={api.protocol} keyAllowed disabled={!writable || busy} />
    </div>
    {writable ? null : <p className="pt-3 text-xs text-text-secondary">Read-only: your team access does not include route changes.</p>}
  </SectionCard>;
}

/**
 * Auth picker for one HTTP/WebSocket route, rendered as a dialog body. Saves
 * via PATCH `.../routes/:routeId`. The key toggle is hidden because the
 * control plane rejects `apiKeyRequired` on non-WebSocket routes.
 */
export function RouteAuthPicker({ api, route, onSaved, onCancel }) {
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

  if (loading) return <LoadingArea label="Loading authorizers" size={32} className="py-4" />;

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

  return <div className="space-y-5">
    <AuthFields form={form} authorizers={authorizers} protocol={api.protocol} keyAllowed={keyAllowed} disabled={!writable || busy} />
    {writable ? null : <p className="text-xs text-text-secondary">Read-only: your team access does not include route changes.</p>}
    <DialogFooter>
      {onCancel ? <Button type="button" variant="outline" className={SECONDARY} onClick={onCancel}>{writable ? "Cancel" : "Close"}</Button> : null}
      {writable ? <Button className={PRIMARY} disabled={busy} onClick={save}>{busy ? <Loader2 className="size-4 animate-spin" /> : null}Save Authorization</Button> : null}
    </DialogFooter>
  </div>;
}
