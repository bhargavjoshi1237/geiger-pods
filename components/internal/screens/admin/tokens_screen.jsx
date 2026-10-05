"use client";

// Access tokens screen (S14 §2, `/settings/tokens`): create (kind, scopes
// picker by permission group, expiry), list with prefix hints, revoke.
// The raw value renders exactly once with copy buttons.

import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound, LockKeyhole } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";

async function api(projectId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/access-tokens${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

const SCOPE_GROUPS = [
  { group: "APIs", scopes: ["pods.apis.view", "pods.api.create", "pods.api.update", "pods.api.delete", "pods.api.*"] },
  { group: "Build", scopes: ["pods.route.write", "pods.integration.write", "pods.model.write", "pods.authorizer.write"] },
  { group: "Release", scopes: ["pods.deployment.create", "pods.stage.write", "pods.stage.promote", "pods.test.invoke"] },
  { group: "Consumers", scopes: ["pods.api_key.write", "pods.usage_plan.write"] },
  { group: "Security", scopes: ["pods.secret.write", "pods.secret.use"] },
  { group: "Operations", scopes: ["pods.logs.view", "pods.export.write"] },
];

export function TokensScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState(null);
  const writable = can("pods.token.write");

  const refresh = useCallback(async () => {
    setState({ status: "loading", items: [], error: null });
    try {
      const data = await api(project.id, "");
      setState({ status: "ready", items: data.items ?? data ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [project.id]);

  useEffect(() => {
    let alive = true;
    api(project.id, "").then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? data ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id]);

  if (!writable) {
    return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
      <ScreenHeader title="Access tokens" description="CLI and automation credentials." />
      <SectionCard><EmptyState icon={LockKeyhole} title="Access unavailable" description="Your current team access does not allow this screen." /></SectionCard>
    </div>;
  }

  return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
    <ScreenHeader
      title="Access tokens"
      description="Personal tokens inherit your current permissions; service tokens carry fixed scopes. Values show once."
      actions={<Button onClick={() => { setFresh(null); setCreating(true); }}><KeyRound className="size-4" />New token</Button>}
    />
    {state.status === "loading" ? <SectionCard><div className="flex justify-center py-10"><LogoLoading /></div></SectionCard> : null}
    {state.status === "error" ? <SectionCard><EmptyState icon={KeyRound} title="Tokens unavailable" description={state.error} action={<Button variant="outline" onClick={refresh}>Retry</Button>} /></SectionCard> : null}
    {state.status === "ready" && state.items.length === 0 ? <SectionCard><EmptyState icon={KeyRound} title="No tokens yet" description="Create one for the CLI: pods login --token …" /></SectionCard> : null}
    {state.status === "ready" && state.items.length > 0 ? <SectionCard title="Tokens" description={`${state.items.length} token${state.items.length === 1 ? "" : "s"}.`}>
      <ul className="divide-y divide-border">
        {state.items.map((token) => <li key={token.id} className="flex flex-wrap items-center gap-3 py-4 first:pt-0 last:pb-0">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{token.name}</p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono">{token.prefix}…</span>
              <Badge variant="outline">{token.kind}</Badge>
              {token.revokedAt ? <Badge variant="outline">revoked</Badge> : <Badge variant="outline">active</Badge>}
              {token.expiresAt ? <span>expires {new Date(token.expiresAt).toLocaleDateString()}</span> : null}
            </p>
          </div>
          {!token.revokedAt ? <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                await api(project.id, `/${encodeURIComponent(token.id)}`, { method: "DELETE" });
                toast.success(`Revoked ${token.name}.`);
                await refresh();
              } catch (error) {
                toast.error(error.message);
              }
            }}
          >Revoke</Button> : null}
        </li>)}
      </ul>
    </SectionCard> : null}
    <Dialog open={creating} onOpenChange={setCreating}>
      <DialogContent>
        <DialogHeader><DialogTitle>New token</DialogTitle><DialogDescription>Personal tokens need an expiry (≤ 1 year). Service tokens cannot exceed your own scopes.</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const scopes = [...form.getAll("scopes")].map(String);
          const payload = {
            kind: String(form.get("kind") ?? "personal"),
            name: String(form.get("name") ?? "").trim(),
            scopes,
            expiresAt: String(form.get("expiresAt") ?? "") || null,
          };
          api(project.id, "", { method: "POST", body: JSON.stringify(payload) }).then(
            (result) => { setFresh(result); setCreating(false); void refresh(); toast.success("Token created — copy it now."); },
            (error) => toast.error(error.message),
          );
        }}>
          <div className="space-y-2">
            <Label htmlFor="token-name">Name</Label>
            <Input id="token-name" name="name" placeholder="laptop cli" required />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="token-kind">Kind</Label>
              <select id="token-kind" name="kind" className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                <option value="personal">personal</option>
                <option value="service">service</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="token-expiry">Expires at</Label>
              <Input id="token-expiry" name="expiresAt" type="date" />
            </div>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Scopes</legend>
            {SCOPE_GROUPS.map((entry) => <details key={entry.group} className="rounded-md border border-border p-2">
              <summary className="cursor-pointer text-sm">{entry.group}</summary>
              <div className="mt-2 space-y-1">
                {entry.scopes.map((scope) => <label key={scope} className="flex items-center gap-2 font-mono text-xs">
                  <input type="checkbox" name="scopes" value={scope} />{scope}
                </label>)}
              </div>
            </details>)}
          </fieldset>
          <DialogFooter><Button type="submit">Create token</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    {fresh?.token ? <SectionCard title="Copy this token now" description="It is never shown again.">
      <div className="flex items-center gap-2">
        <Input readOnly value={fresh.token} spellCheck={false} onFocus={(event) => event.target.select()} />
        <Button variant="outline" size="sm" onClick={() => { void navigator.clipboard?.writeText(fresh.token); toast.success("Token copied."); }}>
          <Copy className="size-4" />Copy
        </Button>
      </div>
      <pre className="mt-3 overflow-x-auto rounded bg-muted p-3 font-mono text-xs">pods login --token {fresh.token}</pre>
    </SectionCard> : null}
  </div>;
}
