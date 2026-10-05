"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderTree, Plus, Trash2 } from "lucide-react";
import { EmptyState, SectionCard } from "@geiger/ui/screen-kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { fetchApis } from "./api_list";
import { MethodDetail } from "./method_view";
import { EnableCorsDialog } from "../processing/cors_editor";

const METHOD_OPTIONS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ANY"];

function depthOf(path) {
  if (path === "/") return 0;
  return path.split("/").length - 1;
}

export function ResourcesTab({ api }) {
  const { project } = useProject();
  const { can } = useRbac();
  const writable = can("pods.route.write");
  const base = `/${encodeURIComponent(api.publicId ?? api.id)}`;
  const [state, setState] = useState({ status: "loading", resources: [], error: null });
  const [methods, setMethods] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [creating, setCreating] = useState(false);
  const [parentId, setParentId] = useState("");
  const [pathPart, setPathPart] = useState("");
  const [methodName, setMethodName] = useState("GET");
  const [busy, setBusy] = useState(false);
  const [corsOpen, setCorsOpen] = useState(false);

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
  const activeMethod = methods[0] ?? null;

  const select = (resourceId) => {
    setSelectedId(resourceId);
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
    return <SectionCard><div className="flex justify-center py-10"><LogoLoading /></div></SectionCard>;
  }
  if (state.status === "error") {
    return <SectionCard><EmptyState icon={FolderTree} title="Resources unavailable" description={state.error} action={<Button variant="outline" onClick={refresh}>Retry</Button>} /></SectionCard>;
  }

  return <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
    <SectionCard
      title="Resource tree"
      description={`${state.resources.length} resources.`}
      actions={writable ? <Button size="sm" onClick={() => { setParentId(selectedId ?? ordered[0]?.id ?? ""); setCreating(true); }}><Plus className="size-4" />Resource</Button> : null}
    >
      <ul className="divide-y divide-border">
        {ordered.map((resource) => <li key={resource.id}>
          <button
            type="button"
            onClick={() => select(resource.id)}
            className={`block w-full truncate rounded px-2 py-2 text-left font-mono text-sm hover:bg-muted ${resource.id === selectedId ? "bg-muted font-medium" : ""}`}
            style={{ paddingLeft: `${0.5 + depthOf(resource.path) * 1.25}rem` }}
          >{resource.path}</button>
        </li>)}
      </ul>
    </SectionCard>
    <div className="space-y-8">
      <SectionCard
        title={selected ? `Methods on ${selected.path}` : "Methods"}
        description={selected ? "Exact method wins; ANY covers the rest. HEAD never falls back to GET." : "Select a resource."}
        actions={writable && selected ? <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setCorsOpen(true)}>Enable CORS</Button>
          <Select value={methodName} onValueChange={setMethodName}>
            <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent>{METHOD_OPTIONS.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent>
          </Select>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => mutate(
              () => fetchApis(project.id, `${base}/resources/${encodeURIComponent(selected.id)}/methods/${methodName}`, { method: "PUT", body: JSON.stringify({}) }),
              `Saved ${methodName} ${selected.path}.`,
            )}
          >Save method</Button>
        </div> : null}
      >
        {methods.length === 0 ? <p className="text-sm text-muted-foreground">No methods yet. Requests here return 403 Missing Authentication Token until a method exists.</p> : null}
        <ul className="divide-y divide-border">
          {methods.map((method) => <li key={method.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
            <Badge variant="outline">{method.httpMethod}</Badge>
            <span className="text-xs text-muted-foreground">{method.authorizationType}{method.apiKeyRequired ? " · key" : ""}{method.operationName ? ` · ${method.operationName}` : ""}</span>
            {writable ? <span className="ml-auto flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => mutate(
                  () => fetchApis(project.id, `${base}/resources/${encodeURIComponent(selected.id)}/methods/${method.httpMethod}`, { method: "DELETE" }),
                  `Deleted ${method.httpMethod} ${selected.path}.`,
                )}
              ><Trash2 className="size-4" />Delete</Button>
            </span> : null}
          </li>)}
        </ul>
      </SectionCard>
      {activeMethod && selected ? <MethodDetail
        key={activeMethod.id}
        api={api}
        resourceId={selected.id}
        method={activeMethod}
        onChanged={() => loadMethods(selected.id).catch((error) => toast.error(error.message))}
      /> : null}
      {writable && selected && selected.path !== "/" ? <SectionCard title="Danger" description="Delete this resource.">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => mutate(
            () => fetchApis(project.id, `${base}/resources/${encodeURIComponent(selected.id)}?recursive=true`, { method: "DELETE" }),
            `Deleted ${selected.path} and its branch.`,
          )}
        ><Trash2 className="size-4" />Delete branch (recursive)</Button>
      </SectionCard> : null}
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
      <DialogContent>
        <DialogHeader><DialogTitle>New resource</DialogTitle><DialogDescription>Literals, {"{param}"} or a trailing {"{proxy+}"}. One variable part per level.</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={(event) => {
          event.preventDefault();
          mutate(
            () => fetchApis(project.id, `${base}/resources`, { method: "POST", body: JSON.stringify({ parentId, pathPart: pathPart.trim() }) }),
            `Created ${pathPart.trim()}.`,
          ).then(() => { setCreating(false); setPathPart(""); });
        }}>
          <div className="space-y-2">
            <Label>Parent</Label>
            <Select value={parentId} onValueChange={setParentId}>
              <SelectTrigger><SelectValue placeholder="Select parent" /></SelectTrigger>
              <SelectContent>{ordered.map((resource) => <SelectItem key={resource.id} value={resource.id}>{resource.path}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="resource-part">Path part</Label>
            <Input id="resource-part" value={pathPart} onChange={(event) => setPathPart(event.target.value)} placeholder="pets, {id} or {proxy+}" required />
          </div>
          <DialogFooter><Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create resource"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>;
}
