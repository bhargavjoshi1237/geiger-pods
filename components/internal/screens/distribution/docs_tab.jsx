"use client";

// Docs tab (REST): documentation parts per location with inheritance
// indicators, a property editor, and frozen versions pinned to stages.

import { useCallback, useEffect, useState } from "react";
import { BookOpen, Layers, Loader2, Pin, Plus, Snowflake, Trash2 } from "lucide-react";
import { DataTable, EmptyState, Field, LoadingArea, SectionCard } from "@/components/internal/shared/screen_kit";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { ListPagination, usePagination } from "@/components/internal/shared/pagination";
import { fetchApis } from "../apis/api_list";

const LOCATION_TYPES = ["API", "AUTHORIZER", "MODEL", "RESOURCE", "METHOD", "PATH_PARAMETER", "QUERY_PARAMETER", "REQUEST_HEADER", "REQUEST_BODY", "RESPONSE", "RESPONSE_HEADER", "RESPONSE_BODY"];

const PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";
const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

function locationDetail(location) {
  return [
    location.method ? `Method ${location.method}` : null,
    location.statusCode ? `Status ${location.statusCode}` : null,
    location.name ? `Name ${location.name}` : null,
  ].filter(Boolean).join(" · ");
}

function inherits(location) {
  return location.method === "*" || location.statusCode === "*";
}

function propertyKeys(properties) {
  if (!properties || typeof properties !== "object") return "—";
  const keys = Object.keys(properties);
  return keys.length ? keys.join(", ") : "—";
}

export function DocsTab({ api, stages }) {
  const { project } = useProject();
  const { can } = useRbac();
  const apiRef = api.publicId ?? api.id;
  const [state, setState] = useState({ status: "loading", parts: [], versions: [], error: null });
  const [form, setForm] = useState({ type: "METHOD", path: "/", method: "*", statusCode: "*", name: "", properties: '{\n  "description": ""\n}' });
  const [versionName, setVersionName] = useState("");
  const [stageName, setStageName] = useState(stages?.[0]?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [freezing, setFreezing] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [pinVersion, setPinVersion] = useState("");
  const canWrite = can("pods.documentation.write");
  const pager = usePagination(state.parts, { resetKey: apiRef });

  const refresh = useCallback(async () => {
    setState({ status: "loading", parts: [], versions: [], error: null });
    try {
      const [parts, versions] = await Promise.all([
        fetchApis(project.id, `/${encodeURIComponent(apiRef)}/documentation/parts`),
        fetchApis(project.id, `/${encodeURIComponent(apiRef)}/documentation/versions`),
      ]);
      setState({ status: "ready", parts: parts.items ?? [], versions: versions.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", parts: [], versions: [], error: error.message });
    }
  }, [project.id, apiRef]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [parts, versions] = await Promise.all([
          fetchApis(project.id, `/${encodeURIComponent(apiRef)}/documentation/parts`),
          fetchApis(project.id, `/${encodeURIComponent(apiRef)}/documentation/versions`),
        ]);
        if (alive) setState({ status: "ready", parts: parts.items ?? [], versions: versions.items ?? [], error: null });
      } catch (error) {
        if (alive) setState({ status: "error", parts: [], versions: [], error: error.message });
      }
    })();
    return () => { alive = false; };
  }, [project.id, apiRef]);

  const create = async () => {
    let properties;
    try {
      properties = JSON.parse(form.properties);
    } catch {
      toast.error("Properties must be valid JSON.");
      return;
    }
    setBusy(true);
    try {
      await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/documentation/parts`, {
        method: "POST",
        body: JSON.stringify({
          location: {
            type: form.type, path: form.path, method: form.method,
            statusCode: form.statusCode, ...(form.name ? { name: form.name } : {}),
          },
          properties,
        }),
      });
      toast.success("Documentation part saved. Wildcards inherit until overridden.");
      setAdding(false);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (part) => {
    setBusy(true);
    try {
      await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/documentation/parts/${encodeURIComponent(part.id)}`, { method: "DELETE" });
      toast.success("Documentation part deleted.");
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const createVersion = async () => {
    if (!versionName.trim()) {
      toast.error("Give the version a name first.");
      return;
    }
    setBusy(true);
    try {
      await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/documentation/versions`, {
        method: "POST",
        body: JSON.stringify({ version: versionName.trim() }),
      });
      toast.success(`Version ${versionName.trim()} frozen. Later edits never touch it.`);
      setVersionName("");
      setFreezing(false);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const openPin = (version) => {
    setPinVersion(version);
    setPinning(true);
  };

  const associate = async () => {
    if (!stageName) {
      toast.error("Pick a stage first.");
      return;
    }
    setBusy(true);
    try {
      await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/stages/${encodeURIComponent(stageName)}/documentation-version`, {
        method: "PUT",
        body: JSON.stringify({ version: pinVersion || null }),
      });
      toast.success(pinVersion ? `Stage ${stageName} now serves documentation version ${pinVersion}.` : `Stage ${stageName} no longer has pinned documentation.`);
      setPinning(false);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  if (state.status === "loading") return <LoadingArea label="Loading documentation" />;
  if (state.status === "error") {
    return <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={BookOpen} title="Documentation unavailable" description={state.error} action={<Button variant="outline" className={SECONDARY} onClick={refresh}>Retry</Button>} /></div>;
  }

  const columns = [
    {
      key: "location",
      header: "Location",
      render: (part) => <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="break-all font-mono text-sm text-foreground">{part.location.path || "/"}</span>
          {inherits(part.location) ? <Badge variant="info">Inherits</Badge> : null}
        </div>
        {locationDetail(part.location) ? <p className="mt-0.5 font-mono text-xs text-text-secondary">{locationDetail(part.location)}</p> : null}
      </div>,
    },
    { key: "type", header: "Type", render: (part) => <Badge variant="outline">{part.location.type}</Badge> },
    { key: "properties", header: "Properties", className: "max-w-60 truncate text-xs text-text-secondary", render: (part) => propertyKeys(part.properties) },
    canWrite ? {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (part) => <ActionMenu
        label={`Actions for ${part.location.type} ${part.location.path}`}
        items={[{ icon: Trash2, label: "Delete", destructive: true, disabled: busy, onSelect: () => setDeleteTarget(part) }]}
      />,
    } : null,
  ].filter(Boolean);

  const versionColumns = [
    {
      key: "version",
      header: "Version",
      render: (entry) => <div className="min-w-0">
        <span className="font-mono font-medium text-foreground">{entry.version}</span>
        {entry.description ? <p className="mt-0.5 max-w-[26rem] truncate text-xs text-text-secondary">{entry.description}</p> : null}
      </div>,
    },
    {
      key: "parts",
      header: "Parts",
      align: "right",
      className: "text-right text-sm tabular-nums text-text-secondary",
      render: (entry) => entry.parts ?? "—",
    },
    {
      key: "createdAt",
      header: "Frozen",
      className: "whitespace-nowrap text-sm text-text-secondary",
      render: (entry) => (entry.createdAt ? new Date(entry.createdAt).toLocaleDateString() : "—"),
    },
    canWrite ? {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (entry) => <ActionMenu
        label={`Actions for version ${entry.version}`}
        items={[{ icon: Pin, label: "Pin to stage…", disabled: busy, onSelect: () => openPin(entry.version) }]}
      />,
    } : null,
  ].filter(Boolean);

  return <div className="space-y-8">
    <SectionCard
      bare
      title="Documentation parts"
      description="Parts with a wildcard method or status code, and parts on parent paths, apply below them until a more specific part overrides them."
      action={canWrite ? <Button size="sm" className={PRIMARY} onClick={() => setAdding(true)}><Plus className="size-4" />Add Part</Button> : null}
    >
      <div className="space-y-3">
        <DataTable
          columns={columns}
          data={pager.pageItems}
          getRowKey={(part) => part.id}
          empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
            icon={BookOpen}
            title="No documentation yet"
            description={canWrite ? "Add the first part, or import an OpenAPI file that carries documentation." : "Documentation parts for this API show up here."}
            action={canWrite ? <Button className={PRIMARY} onClick={() => setAdding(true)}><Plus className="size-4" />Add Part</Button> : null}
          /></div>}
        />
        <ListPagination {...pager} itemLabel="parts" />
      </div>
    </SectionCard>

    <SectionCard
      bare
      title="Versions"
      description="Freeze the current parts into a named version, then pin a version to a stage."
      action={canWrite ? <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" className={SECONDARY} disabled={busy} onClick={() => openPin("")}><Pin className="size-4" />Pin to Stage</Button>
        <Button size="sm" className={PRIMARY} disabled={busy} onClick={() => setFreezing(true)}><Snowflake className="size-4" />Freeze Version</Button>
      </div> : null}
    >
      <DataTable
        columns={versionColumns}
        data={state.versions}
        getRowKey={(entry) => entry.version}
        empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
          icon={Layers}
          title="No versions yet"
          description="Freeze one to pin stage docs."
        /></div>}
      />
    </SectionCard>

    <Dialog open={adding} onOpenChange={setAdding}>
      <DialogContent className="max-w-xl bg-background">
        <DialogHeader>
          <DialogTitle>Add Documentation Part</DialogTitle>
          <DialogDescription>Attach properties to a location. Use * for the method or status code to cover every match.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Location type" htmlFor="docs-part-type">
              <Select value={form.type} onValueChange={(value) => setForm({ ...form, type: value })}>
                <SelectTrigger id="docs-part-type" aria-label="Location type"><SelectValue /></SelectTrigger>
                <SelectContent>{LOCATION_TYPES.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Path" htmlFor="docs-part-path">
              <Input id="docs-part-path" value={form.path} onChange={(event) => setForm({ ...form, path: event.target.value })} placeholder="/pets" className="font-mono" aria-label="Path" />
            </Field>
            <Field label="Method" htmlFor="docs-part-method">
              <Input id="docs-part-method" value={form.method} onChange={(event) => setForm({ ...form, method: event.target.value })} placeholder="* or GET" className="font-mono" aria-label="Method" />
            </Field>
            <Field label="Status code" htmlFor="docs-part-status">
              <Input id="docs-part-status" value={form.statusCode} onChange={(event) => setForm({ ...form, statusCode: event.target.value })} placeholder="* or 200" className="font-mono" aria-label="Status code" />
            </Field>
          </div>
          <Field label="Properties" htmlFor="docs-part-properties" hint="A JSON object, such as a description and summary.">
            <Textarea id="docs-part-properties" value={form.properties} onChange={(event) => setForm({ ...form, properties: event.target.value })} rows={5} className="font-mono text-xs" aria-label="Properties JSON" spellCheck={false} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" className={SECONDARY} onClick={() => setAdding(false)}>Cancel</Button>
          <Button className={PRIMARY} disabled={busy} onClick={create}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Add Part
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={freezing} onOpenChange={(next) => { setFreezing(next); if (!next) setVersionName(""); }}>
      <DialogContent className="bg-background sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Freeze Version</DialogTitle>
          <DialogDescription>Snapshot the current documentation parts under a name. Later edits never touch a frozen version.</DialogDescription>
        </DialogHeader>
        <Field label="Version name" htmlFor="docs-version-name">
          <Input id="docs-version-name" value={versionName} onChange={(event) => setVersionName(event.target.value)} placeholder="v1" autoFocus />
        </Field>
        <DialogFooter>
          <Button variant="outline" className={SECONDARY} onClick={() => { setFreezing(false); setVersionName(""); }}>Cancel</Button>
          <Button className={PRIMARY} disabled={busy} onClick={createVersion}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Freeze Version
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={pinning} onOpenChange={setPinning}>
      <DialogContent className="bg-background sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Pin to Stage</DialogTitle>
          <DialogDescription>Choose which frozen version a stage serves. Pick no version to unpin it.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Stage" htmlFor="docs-stage">
            <Select value={stageName || "__none__"} onValueChange={(value) => setStageName(value === "__none__" ? "" : value)}>
              <SelectTrigger id="docs-stage" aria-label="Stage"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Pick a stage…</SelectItem>
                {(stages ?? []).map((entry) => <SelectItem key={entry.name} value={entry.name}>{entry.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Version" htmlFor="docs-pin-version">
            <Select value={pinVersion || "__none__"} onValueChange={(value) => setPinVersion(value === "__none__" ? "" : value)}>
              <SelectTrigger id="docs-pin-version" aria-label="Version"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No version (unpin)</SelectItem>
                {state.versions.map((entry) => <SelectItem key={entry.version} value={entry.version}>{entry.version}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" className={SECONDARY} onClick={() => setPinning(false)}>Cancel</Button>
          <Button className={PRIMARY} disabled={busy} onClick={associate}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {pinVersion ? "Pin Version" : "Unpin"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
      <DialogContent className="bg-background sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete documentation part</DialogTitle>
          <DialogDescription>
            Delete the <span className="font-medium text-foreground">{deleteTarget?.location.type}</span> part at{" "}
            <span className="font-mono text-foreground">{deleteTarget?.location.path}</span>? Frozen versions keep their copy.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button className="bg-red-500/90 text-white hover:bg-red-500" disabled={busy} onClick={async () => { const part = deleteTarget; setDeleteTarget(null); await remove(part); }}>
            <Trash2 className="size-4" />Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
