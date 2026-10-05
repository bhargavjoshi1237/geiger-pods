"use client";

// Connectors screen (S04 §4 + §7): list with status dot, agents online and
// last seen; create flow shows the token once plus a copy-paste node command;
// detail view covers agents, allowed targets and token rotate/revoke.

import { useCallback, useEffect, useState } from "react";
import { Cable, Copy, LockKeyhole, Plus, RotateCw } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";

const STATUS_STYLE = {
  AVAILABLE: "bg-emerald-500",
  DEGRADED: "bg-amber-500",
  FAILED: "bg-red-500",
  PENDING: "bg-zinc-400",
  DELETING: "bg-zinc-400",
};

async function api(projectId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/connectors${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

function TokenOnce({ token, agentCommand }) {
  return <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
    <p className="text-sm font-medium">Copy this token now — it is never shown again.</p>
    <div className="flex items-center gap-2">
      <Input readOnly value={token} spellCheck={false} onFocus={(event) => event.target.select()} />
      <Button variant="outline" size="sm" onClick={() => { void navigator.clipboard?.writeText(token); toast.success("Token copied."); }}>
        <Copy className="size-4" />Copy
      </Button>
    </div>
    <p className="text-xs text-muted-foreground">Run the agent inside your private network:</p>
    <pre className="overflow-x-auto rounded bg-muted p-3 font-mono text-xs">{agentCommand}</pre>
  </div>;
}

export function ConnectorsScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [creating, setCreating] = useState(false);
  const [freshToken, setFreshToken] = useState(null);
  const [selected, setSelected] = useState(null);
  const [tokens, setTokens] = useState([]);
  const [busy, setBusy] = useState(false);
  const writable = can("pods.connector.write");

  const refresh = useCallback(async () => {
    setState({ status: "loading", items: [], error: null });
    try {
      const data = await api(project.id, "");
      setState({ status: "ready", items: data.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [project.id]);

  const openDetail = useCallback(async (connector) => {
    setSelected(connector);
    try {
      const data = await api(project.id, `/${encodeURIComponent(connector.id)}/tokens`);
      setTokens(data.items ?? []);
    } catch {
      setTokens([]);
    }
  }, [project.id]);

  useEffect(() => {
    let alive = true;
    api(project.id, "").then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id]);

  if (!writable) {
    return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
      <ScreenHeader title="Connectors" description="Private links into your VPC." />
      <SectionCard><EmptyState icon={LockKeyhole} title="Access unavailable" description="Your current team access does not allow this screen." /></SectionCard>
    </div>;
  }

  const mutate = async (work, success) => {
    setBusy(true);
    try {
      const result = await work();
      toast.success(success);
      await refresh();
      if (selected) {
        const data = await api(project.id, "");
        const next = (data.items ?? []).find((entry) => entry.id === selected.id) ?? null;
        setSelected(next);
        if (next) {
          const tokenData = await api(project.id, `/${encodeURIComponent(next.id)}/tokens`);
          setTokens(tokenData.items ?? []);
        }
      }
      return result;
    } catch (mutationError) {
      toast.error(mutationError.message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
    <ScreenHeader
      title="Connectors"
      description="Outbound agents reach private backends (VPC-link equivalent). No inbound firewall rules needed."
      actions={<Button onClick={() => setCreating(true)}><Plus className="size-4" />New connector</Button>}
    />
    {state.status === "loading" ? <SectionCard><div className="flex justify-center py-10"><LogoLoading /></div></SectionCard> : null}
    {state.status === "error" ? <SectionCard><EmptyState icon={Cable} title="Connectors unavailable" description={state.error} action={<Button variant="outline" onClick={refresh}>Retry</Button>} /></SectionCard> : null}
    {state.status === "ready" && state.items.length === 0 ? <SectionCard><EmptyState icon={Cable} title="No connectors yet" description="Create one, then run its agent inside your private network." action={<Button onClick={() => setCreating(true)}>New connector</Button>} /></SectionCard> : null}
    {state.status === "ready" && state.items.length > 0 ? <SectionCard title="Connectors" description={`${state.items.length} private link${state.items.length === 1 ? "" : "s"}.`}>
      <ul className="divide-y divide-border">
        {state.items.map((connector) => <li key={connector.id} className="flex flex-wrap items-center gap-3 py-4 first:pt-0 last:pb-0">
          <span className={`size-2.5 rounded-full ${STATUS_STYLE[connector.status] ?? "bg-zinc-400"}`} title={connector.status} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{connector.name}</p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">{connector.status}</Badge>
              <span>{connector.agentCount} agent{connector.agentCount === 1 ? "" : "s"}</span>
              {connector.lastSeenAt ? <span>last seen {new Date(connector.lastSeenAt).toLocaleString()}</span> : <span>never seen</span>}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => openDetail(connector)}>Details</Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => mutate(
                () => api(project.id, `/${encodeURIComponent(connector.id)}`, { method: "DELETE" }),
                `Deleted ${connector.name}.`,
              ).then(() => { if (selected?.id === connector.id) setSelected(null); })}
            >Delete</Button>
          </div>
        </li>)}
      </ul>
    </SectionCard> : null}
    {selected ? <SectionCard
      title={selected.name}
      description={selected.statusMessage ?? `Status ${selected.status}. Agents enforce the allow-list locally; the gateway checks it too.`}
      actions={<Button variant="outline" size="sm" onClick={() => setSelected(null)}>Close</Button>}
    >
      <div className="space-y-4">
        <div>
          <p className="text-sm font-medium">Allowed targets</p>
          <p className="font-mono text-xs text-muted-foreground">{(selected.allowedTargets ?? []).join(", ") || "None — no traffic can flow."}</p>
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium">Tokens</p>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={async () => {
                const result = await mutate(
                  () => api(project.id, `/${encodeURIComponent(selected.id)}/tokens`, { method: "POST" }),
                  "Token created.",
                );
                if (result?.token) {
                  const data = await api(project.id, `/${encodeURIComponent(selected.id)}/tokens`);
                  setTokens(data.items ?? []);
                  setFreshToken({ token: result.token, prefix: result.prefix });
                }
              }}
            >New token</Button>
          </div>
          {freshToken ? <div className="mb-3"><TokenOnce
            token={freshToken.token}
            agentCommand={`node connector/agent.mjs --url wss://<gateway>/_connector --token ${freshToken.token} --targets ${(selected.allowedTargets ?? []).join(",")}`}
          /></div> : null}
          <ul className="divide-y divide-border">
            {tokens.map((token) => <li key={token.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
              <p className="min-w-0 flex-1 font-mono text-xs">{token.prefix}… {token.revokedAt ? <Badge variant="outline">revoked</Badge> : <Badge variant="outline">active</Badge>}</p>
              {!token.revokedAt ? <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={async () => {
                    const result = await mutate(
                      () => api(project.id, `/${encodeURIComponent(selected.id)}/tokens/${encodeURIComponent(token.id)}`, {
                        method: "POST",
                        body: JSON.stringify({ action: "rotate" }),
                      }),
                      "Token rotated.",
                    );
                    if (result?.created?.token) {
                      const data = await api(project.id, `/${encodeURIComponent(selected.id)}/tokens`);
                      setTokens(data.items ?? []);
                      setFreshToken({ token: result.created.token, prefix: result.created.prefix });
                    }
                  }}
                ><RotateCw className="size-4" />Rotate</Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => mutate(
                    () => api(project.id, `/${encodeURIComponent(selected.id)}/tokens/${encodeURIComponent(token.id)}`, { method: "DELETE" }),
                    "Token revoked.",
                  )}
                >Revoke</Button>
              </div> : null}
            </li>)}
          </ul>
          {tokens.length === 0 ? <p className="text-xs text-muted-foreground">No tokens yet — create one to connect an agent.</p> : null}
        </div>
      </div>
    </SectionCard> : null}
    <Dialog open={creating} onOpenChange={setCreating}>
      <DialogContent>
        <DialogHeader><DialogTitle>New connector</DialogTitle><DialogDescription>Agents dial out, so your firewall needs no inbound rules.</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const targets = String(form.get("targets") ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
          void mutate(
            () => api(project.id, "", {
              method: "POST",
              body: JSON.stringify({ name: String(form.get("name") ?? "").trim(), allowedTargets: targets }),
            }),
            "Connector created.",
          ).then(() => setCreating(false));
        }}>
          <div className="space-y-2">
            <Label htmlFor="connector-name">Name</Label>
            <Input id="connector-name" name="name" placeholder="vpc-a" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="connector-targets">Allowed targets (comma-separated host:port or CIDR:port)</Label>
            <Textarea id="connector-targets" name="targets" placeholder="orders.internal:8080, 10.0.0.0/8:8080" rows={2} spellCheck={false} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create connector"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>;
}
