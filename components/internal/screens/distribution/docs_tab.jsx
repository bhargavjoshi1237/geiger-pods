"use client";

// Docs tab (S13 part B, REST): tree of documentation locations with
// inheritance indicators, property editor, versions list (create version,
// associate with stage).

import { useCallback, useEffect, useState } from "react";
import { BookOpen } from "lucide-react";
import { EmptyState, LoadingArea, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { fetchApis } from "../apis/api_list";

const LOCATION_TYPES = ["API", "AUTHORIZER", "MODEL", "RESOURCE", "METHOD", "PATH_PARAMETER", "QUERY_PARAMETER", "REQUEST_HEADER", "REQUEST_BODY", "RESPONSE", "RESPONSE_HEADER", "RESPONSE_BODY"];

function locationLabel(location) {
  return `${location.type} ${location.path}${location.method && location.method !== "*" ? ` ${location.method}` : ""}${location.statusCode && location.statusCode !== "*" ? ` ${location.statusCode}` : ""}${location.name ? ` ${location.name}` : ""}`;
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
  const canWrite = can("pods.documentation.write");

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
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
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
        body: JSON.stringify({ version: versionName.trim() || null }),
      });
      toast.success(`Stage ${stageName} now serves its pinned documentation.`);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  if (state.status === "loading") return <SectionCard><LoadingArea label="Loading documentation" /></SectionCard>;
  if (state.status === "error") {
    return <SectionCard><EmptyState icon={BookOpen} title="Documentation unavailable" description={state.error} action={<Button variant="outline" onClick={refresh}>Retry</Button>} /></SectionCard>;
  }

  return (
    <div className="space-y-4">
      <ScreenHeader title="Documentation" description="Parts inherit per AWS rules: method *, statusCode * and parent paths apply unless overridden." />
      <SectionCard>
        <h3 className="text-sm font-medium">Parts ({state.parts.length})</h3>
        {state.parts.length === 0
          ? <EmptyState icon={BookOpen} title="No documentation yet" description="Add the first part below, or import an OpenAPI file carrying x-amazon-apigateway-documentation." />
          : (
            <ul className="mt-2 space-y-1">
              {state.parts.map((part) => (
                <li key={part.id} className="flex items-center justify-between gap-2 rounded border border-border p-2 text-sm">
                  <span className="min-w-0 break-all font-mono text-xs">
                    {locationLabel(part.location)}
                    {(part.location.method === "*" || part.location.statusCode === "*") ? <span className="ml-2 rounded bg-muted px-1">inherits</span> : null}
                  </span>
                  {canWrite ? <Button variant="outline" size="sm" className="shrink-0" disabled={busy} onClick={() => remove(part)}>Delete</Button> : null}
                </li>
              ))}
            </ul>
          )}
      </SectionCard>
      {canWrite ? (
        <SectionCard>
          <h3 className="text-sm font-medium">New part</h3>
          <div className="mt-2 grid grid-cols-2 items-center gap-2 sm:grid-cols-[12rem_minmax(0,1fr)_6rem_6rem]">
            <Select value={form.type} onValueChange={(value) => setForm({ ...form, type: value })}>
              <SelectTrigger className="col-span-2 sm:col-span-1" aria-label="Location type"><SelectValue /></SelectTrigger>
              <SelectContent>{LOCATION_TYPES.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectContent>
            </Select>
            <Input value={form.path} onChange={(event) => setForm({ ...form, path: event.target.value })} placeholder="/pets" className="col-span-2 font-mono sm:col-span-1" aria-label="Path" />
            <Input value={form.method} onChange={(event) => setForm({ ...form, method: event.target.value })} placeholder="* or GET" className="font-mono" aria-label="Method" />
            <Input value={form.statusCode} onChange={(event) => setForm({ ...form, statusCode: event.target.value })} placeholder="* or 200" className="font-mono" aria-label="Status code" />
          </div>
          <Textarea value={form.properties} onChange={(event) => setForm({ ...form, properties: event.target.value })} rows={4} className="mt-2 font-mono text-xs" aria-label="Properties JSON" spellCheck={false} />
          <Button className="mt-2" disabled={busy} onClick={create}>Save part</Button>
        </SectionCard>
      ) : null}
      <SectionCard>
        <h3 className="text-sm font-medium">Versions ({state.versions.length})</h3>
        {state.versions.length === 0
          ? <p className="mt-1 text-sm text-muted-foreground">No versions yet. Freeze one to pin stage docs.</p>
          : (
            <ul className="mt-2 space-y-1 text-sm">
              {state.versions.map((entry) => <li key={entry.version} className="rounded border border-border p-2 font-mono text-xs">{entry.version} · {entry.parts} parts</li>)}
            </ul>
          )}
        {canWrite ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Input value={versionName} onChange={(event) => setVersionName(event.target.value)} placeholder="v1" className="w-full sm:w-40" aria-label="Version name" />
            <Button variant="outline" disabled={busy} onClick={createVersion}>Freeze version</Button>
            <Select value={stageName || "__none__"} onValueChange={(value) => setStageName(value === "__none__" ? "" : value)}>
              <SelectTrigger className="w-full sm:w-48" aria-label="Stage"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Pick a stage…</SelectItem>
                {(stages ?? []).map((entry) => <SelectItem key={entry.name} value={entry.name}>{entry.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="outline" disabled={busy} onClick={associate}>Pin version to stage</Button>
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
}
