"use client";

import { useCallback, useEffect, useState } from "react";
import { LockKeyhole, ShieldCheck, UserPlus } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";

async function api(projectId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/role-grants${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

export function TeamAccessScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [granting, setGranting] = useState(false);
  const [busy, setBusy] = useState(false);
  const manageable = can("pods.role.grant");

  const refresh = useCallback(async () => {
    setState((current) => ({ ...current, status: "loading", error: null }));
    try {
      const data = await api(project.id, "");
      setState({ status: "ready", items: data.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
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

  const mutate = async (work, success) => {
    setBusy(true);
    try {
      await work();
      toast.success(success);
      await refresh();
    } catch (mutationError) {
      toast.error(mutationError.message);
    } finally {
      setBusy(false);
    }
  };

  if (!manageable) {
    return <div className="mx-auto w-full max-w-5xl space-y-6 px-2 py-4 lg:px-0">
      <ScreenHeader title="Team access" description="Product role grants for this project." />
      <SectionCard><EmptyState icon={LockKeyhole} title="Access unavailable" description="Your current team access does not allow this screen." /></SectionCard>
    </div>;
  }

  return <div className="mx-auto w-full max-w-5xl space-y-6 px-2 py-4 lg:px-0">
    <ScreenHeader
      title="Team access"
      description="Grant product roles to teammates. You can never grant a role holding a permission you lack yourself."
      actions={<Button onClick={() => setGranting(true)}><UserPlus className="size-4" />Grant role</Button>}
    />
    {state.status === "loading" ? <SectionCard><div className="flex justify-center py-8"><LogoLoading /></div></SectionCard> : null}
    {state.status === "error" ? <SectionCard><EmptyState icon={ShieldCheck} title="Grants unavailable" description={state.error} action={<Button variant="outline" onClick={refresh}>Retry</Button>} /></SectionCard> : null}
    {state.status === "ready" && state.items.length === 0 ? <SectionCard><EmptyState icon={ShieldCheck} title="No product grants yet" description="Everyone here inherits access from the Geiger team. Grant a product role to narrow or extend it." action={<Button onClick={() => setGranting(true)}>Grant role</Button>} /></SectionCard> : null}
    {state.status === "ready" && state.items.length > 0 ? <SectionCard title="Product grants" description={`${state.items.length} active grant${state.items.length === 1 ? "" : "s"}.`}>
      <ul className="divide-y divide-border">
        {state.items.map((grant) => <li key={grant.id} className="flex flex-wrap items-center gap-3 py-4 first:pt-0 last:pb-0">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{grant.roleName ?? grant.roleKey}</p>
            <p className="mt-1 truncate text-xs text-muted-foreground">User {grant.userId}{grant.scope?.api?.length > 0 ? ` · scoped to ${grant.scope.api.length} API${grant.scope.api.length === 1 ? "" : "s"}` : ""}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => mutate(
              () => api(project.id, `?id=${encodeURIComponent(grant.id)}`, { method: "DELETE" }),
              "Grant revoked.",
            )}
          >Revoke</Button>
        </li>)}
      </ul>
    </SectionCard> : null}
    <Dialog open={granting} onOpenChange={setGranting}>
      <DialogContent>
        <DialogHeader><DialogTitle>Grant role</DialogTitle><DialogDescription>Optionally narrow the grant to specific API ids (comma-separated).</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const apiIds = String(form.get("apis") ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
          mutate(
            () => api(project.id, "", {
              method: "POST",
              body: JSON.stringify({
                userId: String(form.get("userId") ?? "").trim(),
                roleKey: String(form.get("roleKey") ?? "").trim(),
                ...(apiIds.length > 0 ? { scope: { api: apiIds } } : {}),
              }),
            }),
            "Role granted.",
          ).then(() => setGranting(false));
        }}>
          <div className="space-y-2">
            <Label htmlFor="grant-user">User ID</Label>
            <Input id="grant-user" name="userId" required placeholder="00000000-0000-4000-8000-000000000000" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="grant-role">Role key</Label>
            <Input id="grant-role" name="roleKey" required placeholder="api_developer" pattern="[a-z][a-z0-9_]*" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="grant-apis">API ids (optional)</Label>
            <Input id="grant-apis" name="apis" placeholder="a1b2c3d4e5, f6g7h8i9j0" />
          </div>
          <DialogFooter><Button type="submit" disabled={busy}>{busy ? "Granting…" : "Grant role"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>;
}
