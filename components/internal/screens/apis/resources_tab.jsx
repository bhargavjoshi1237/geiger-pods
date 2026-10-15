"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderTree, KeyRound, Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { EmptyState, Field, LoadingArea, SectionCard } from "@/components/internal/shared/screen_kit";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { fetchApis } from "./api_list";
import { MethodDetail } from "./method_view";
import { EnableCorsDialog } from "../processing/cors_editor";

const METHOD_OPTIONS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ANY"];
const AUTH_LABEL = { NONE: "No auth", SIGNED: "Signed requests", JWT: "JWT", CUSTOM: "Custom authorizer" };
const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";
const PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";

function depthOf(path) {
  if (path === "/") return 0;
  return path.split("/").length - 1;
}

function leafOf(path) {
  if (path === "/") return "/";
  return `/${path.split("/").pop()}`;
}

function MethodRow({ method, current, writable, busy, onSelect, onDelete }) {
  return <div
    role="button"
    tabIndex={0}
    aria-pressed={current}
    onClick={() => onSelect(method)}
    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(method); } }}
    className={`flex cursor-pointer flex-wrap items-center gap-3 rounded-xl border px-4 py-3 transition-colors ${current ? "border-border-strong bg-surface-active" : "border-border bg-surface-card hover:bg-surface-subtle"}`}
  >
    <Badge variant="outline" className="w-16 justify-center font-mono">{method.httpMethod}</Badge>
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
        <span className="flex items-center gap-1"><ShieldCheck className="size-3.5" />{AUTH_LABEL[method.authorizationType] ?? method.authorizationType ?? "No auth"}</span>
        {method.apiKeyRequired ? <span className="flex items-center gap-1"><KeyRound className="size-3.5" />API key required</span> : null}
        {method.operationName ? <span className="truncate font-mono">{method.operationName}</span> : null}
      </div>
    </div>
    {current ? <span className="text-xs text-text-tertiary">Details below</span> : null}
    {writable ? <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}><ActionMenu
      label={`Actions for ${method.httpMethod}`}
      disabled={busy}
      items={[{ icon: Trash2, label: "Delete method", destructive: true, onSelect: () => onDelete(method) }]}
    /></span> : null}
  </div>;
}

export function ResourcesTab({ api }) {
  const { project } = useProject();
  const { can } = useRbac();
  const writable = can("pods.route.write");
  const base = `/${encodeURIComponent(api.publicId ?? api.id)}`;
  const [state, setState] = useState({ status: "loading", resources: [], error: null });
  const [methods, setMethods] = useState([]);
  const [methodKey, setMethodKey] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [parentId, setParentId] = useState("");
  const [pathPart, setPathPart] = useState("");
  const [methodName, setMethodName] = useState("GET");
  const [busy, setBusy] = useState(false);
  const [corsOpen, setCorsOpen] = useState(false);
  const [deleteMethod, setDeleteMethod] = useState(null);
  const [deleteBranchOpen, setDeleteBranchOpen] = useState(false);

  const loadResources = useCallback(async () => {
    const data = await fetchApis(project.id, `${base}/resources?limit=100`);
    return data.items ?? [];
  }, [project.id, base]);

  const loadMethods = useCallback(async (resourceId) => {
    if (!resourceId) {
      setMethods([]);
      return;
    }
    const results = await Promise.all(METHOD_OPTIONS.map(async (httpMethod) => {
      try {
        return await fetchApis(project.id, `${base}/resources/${encodeURIComponent(resourceId)}/methods/${httpMethod}`);
      } catch {
        return null;
      }
    }));
    setMethods(results.filter(Boolean));
  }, [project.id, base]);

  const refresh = useCallback(async () => {
    setState({ status: "loading", resources: [], error: null });
    try {
      const items = await loadResources();
      setState({ status: "ready", resources: items, error: null });
      const keep = items.some((resource) => resource.id === selectedId) ? selectedId : items[0]?.id ?? null;
      setSelectedId(keep);
      await loadMethods(keep);
    } catch (error) {
      setState({ status: "error", resources: [], error: error.message });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadResources, loadMethods]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const items = await loadResources();
        if (!alive) return;
        setState({ status: "ready", resources: items, error: null });
        const first = items[0]?.id ?? null;
        setSelectedId(first);
        await loadMethods(first);
      } catch (error) {
        if (alive) setState({ status: "error", resources: [], error: error.message });
      }
    })();
    return () => { alive = false; };
  }, [loadResources, loadMethods]);

  const ordered = useMemo(
    () => [...state.resources].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    [state.resources],
  );
  const selected = state.resources.find((resource) => resource.id === selectedId) ?? null;
  const activeMethod = methods.find((method) => method.httpMethod === methodKey) ?? methods[0] ?? null;

  const select = (resourceId) => {
    setSelectedId(resourceId);
    setMethodKey(null);
    loadMethods(resourceId).catch((error) => toast.error(error.message));
  };

  const mutate = async (work, success) => {
    setBusy(true);
    try {
      await work();
      toast.success(success);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  if (state.status === "loading") {
    return <LoadingArea label="Loading resources" />;
  }
  if (state.status === "error") {
    return <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={FolderTree} title="Resources unavailable" description={state.error} action={<Button variant="outline" size="sm" className={SECONDARY} onClick={refresh}>Retry</Button>} /></div>;
  }

  return <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
    <SectionCard
      bare
      title="Resource tree"
      description={`${state.resources.length} ${state.resources.length === 1 ? "resource" : "resources"}`}
      action={writable ? <Button size="sm" className={PRIMARY} onClick={() => { setParentId(selectedId ?? ordered[0]?.id ?? ""); setCreating(true); }}><Plus className="size-4" />New Resource</Button> : null}
    >
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-card">
        {ordered.map((resource) => {
          const active = resource.id === selectedId;
          return <li key={resource.id}>
            <button
              type="button"
              onClick={() => select(resource.id)}
              title={resource.path}
              aria-current={active ? "true" : undefined}
              className={`flex w-full items-center gap-2 py-2.5 pr-3 text-left font-mono text-sm transition-colors ${active ? "bg-surface-active font-medium text-foreground" : "text-text-secondary hover:bg-surface-subtle hover:text-foreground"}`}
              style={{ paddingLeft: `${0.75 + depthOf(resource.path) * 1.25}rem` }}
            >
              {depthOf(resource.path) > 0 ? <span aria-hidden className="text-text-tertiary">└</span> : null}
              <span className="truncate">{leafOf(resource.path)}</span>
            </button>
          </li>;
        })}
      </ul>
    </SectionCard>
    <div className="min-w-0 space-y-8">
      <SectionCard
        bare
        title="Methods"
        description={selected ? <>On <span className="font-mono text-foreground">{selected.path}</span>. An exact method wins; ANY covers the rest. HEAD never falls back to GET.</> : "Select a resource."}
        action={writable && selected ? <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" size="sm" className={SECONDARY} disabled={busy} onClick={() => setCorsOpen(true)}>Enable CORS</Button>
          <Select value={methodName} onValueChange={setMethodName}>
            <SelectTrigger size="sm" className="w-28 font-mono" aria-label="HTTP method"><SelectValue /></SelectTrigger>
            <SelectContent>{METHOD_OPTIONS.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent>
          </Select>
          <Button
            size="sm"
            className={PRIMARY}
            disabled={busy}
            onClick={() => mutate(
              () => fetchApis(project.id, `${base}/resources/${encodeURIComponent(selected.id)}/methods/${methodName}`, { method: "PUT", body: JSON.stringify({}) }),
              `Saved ${methodName} ${selected.path}.`,
            )}
          ><Plus className="size-4" />Add Method</Button>
        </div> : null}
      >
        {methods.length === 0 ? <div className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-surface-card px-6 py-10 text-center text-text-secondary">
          <FolderTree className="size-6" />
          <p className="text-sm">No methods on this resource yet — requests here get 403 Missing Authentication Token until you add one</p>
        </div> : <div className="space-y-2">
          {methods.map((method) => <MethodRow key={method.id} method={method} current={method === activeMethod} writable={writable} busy={busy} onSelect={(next) => setMethodKey(next.httpMethod)} onDelete={setDeleteMethod} />)}
        </div>}
      </SectionCard>
      {activeMethod && selected ? <MethodDetail
        key={activeMethod.id}
        api={api}
        resourceId={selected.id}
        method={activeMethod}
        onChanged={() => loadMethods(selected.id).catch((error) => toast.error(error.message))}
      /> : null}
      {writable && selected && selected.path !== "/" ? <SectionCard
        bare
        bodyPadding={false}
        title="Delete resource"
        description={<>Removes <span className="font-mono text-foreground">{selected.path}</span> along with every resource and method beneath it.</>}
        action={<Button variant="outline" size="sm" className="border-border bg-transparent text-destructive-text hover:bg-surface-active" disabled={busy} onClick={() => setDeleteBranchOpen(true)}><Trash2 className="size-4" />Delete branch</Button>}
      /> : null}
      <EnableCorsDialog
        open={corsOpen}
        onOpenChange={setCorsOpen}
        onConfirm={(input) => mutate(
          () => fetchApis(project.id, `${base}/resources/${encodeURIComponent(selected.id)}/enable-cors`, { method: "POST", body: JSON.stringify(input) }),
          `Enabled CORS on ${selected.path}.`,
        )}
      />
    </div>
    <Dialog open={creating} onOpenChange={setCreating}>
      <DialogContent className="max-w-xl bg-background">
        <DialogHeader><DialogTitle>New Resource</DialogTitle><DialogDescription>Add a path segment under an existing resource.</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={(event) => {
          event.preventDefault();
          mutate(
            () => fetchApis(project.id, `${base}/resources`, { method: "POST", body: JSON.stringify({ parentId, pathPart: pathPart.trim() }) }),
            `Created ${pathPart.trim()}.`,
          ).then(() => { setCreating(false); setPathPart(""); });
        }}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Parent" htmlFor="resource-parent">
              <Select value={parentId} onValueChange={setParentId}>
                <SelectTrigger id="resource-parent" className="w-full font-mono"><SelectValue placeholder="Select parent" /></SelectTrigger>
                <SelectContent>{ordered.map((resource) => <SelectItem key={resource.id} value={resource.id} className="font-mono">{resource.path}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Path part" htmlFor="resource-part" hint={<>A literal, a {"{param}"} or a trailing {"{proxy+}"}. One variable part per level.</>}>
              <Input id="resource-part" value={pathPart} onChange={(event) => setPathPart(event.target.value)} placeholder="pets, {id} or {proxy+}" className="font-mono" required />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" className={SECONDARY} onClick={() => setCreating(false)}>Cancel</Button>
            <Button type="submit" className={PRIMARY} disabled={busy}>{busy ? <Loader2 className="size-4 animate-spin" /> : null}Create Resource</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(deleteMethod)} onOpenChange={(open) => { if (!open) setDeleteMethod(null); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete method</DialogTitle>
          <DialogDescription>Delete <span className="font-mono font-medium text-foreground">{deleteMethod?.httpMethod} {selected?.path}</span>? Its request, response and integration settings go with it. This can&apos;t be undone.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setDeleteMethod(null)}>Cancel</Button>
          <Button
            className="bg-red-500/90 text-white hover:bg-red-500"
            disabled={busy}
            onClick={() => {
              const method = deleteMethod;
              setDeleteMethod(null);
              mutate(
                () => fetchApis(project.id, `${base}/resources/${encodeURIComponent(selected.id)}/methods/${method.httpMethod}`, { method: "DELETE" }),
                `Deleted ${method.httpMethod} ${selected.path}.`,
              );
            }}
          ><Trash2 className="size-4" />Delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={deleteBranchOpen} onOpenChange={setDeleteBranchOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete resource</DialogTitle>
          <DialogDescription>Delete <span className="font-mono font-medium text-foreground">{selected?.path}</span> and everything beneath it, including all child resources and their methods? This can&apos;t be undone.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setDeleteBranchOpen(false)}>Cancel</Button>
          <Button
            className="bg-red-500/90 text-white hover:bg-red-500"
            disabled={busy}
            onClick={() => {
              setDeleteBranchOpen(false);
              mutate(
                () => fetchApis(project.id, `${base}/resources/${encodeURIComponent(selected.id)}?recursive=true`, { method: "DELETE" }),
                `Deleted ${selected.path} and its branch.`,
              );
            }}
          ><Trash2 className="size-4" />Delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
