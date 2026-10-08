"use client";

// Docs tab (S13 part B, REST): tree of documentation locations with
// inheritance indicators, property editor, versions list (create version,
// associate with stage).

import { useCallback, useEffect, useState } from "react";
import { BookOpen } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
import { LogoLoading } from "@geiger/ui/logo-loading";
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

  if (state.status === "loading") return <SectionCard><div className="flex justify-center py-10"><LogoLoading /></div></SectionCard>;
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
                  <span className="font-mono text-xs">
                    {locationLabel(part.location)}
                    {(part.location.method === "*" || part.location.statusCode === "*") ? <span className="ml-2 rounded bg-muted px-1">inherits</span> : null}
                  </span>
                  {canWrite ? <Button variant="outline" disabled={busy} onClick={() => remove(part)}>Delete</Button> : null}
                </li>
              ))}
            </ul>
          )}
      </SectionCard>
      {canWrite ? (
        <SectionCard>
          <h3 className="text-sm font-medium">New part</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            <select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })} className="rounded-md border border-border bg-background px-2 py-1 text-sm" aria-label="Location type">
              {LOCATION_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
            <input value={form.path} onChange={(event) => setForm({ ...form, path: event.target.value })} placeholder="/pets" className="rounded-md border border-border bg-background px-2 py-1 text-sm" aria-label="Path" />
            <input value={form.method} onChange={(event) => setForm({ ...form, method: event.target.value })} placeholder="* or GET" className="w-24 rounded-md border border-border bg-background px-2 py-1 text-sm" aria-label="Method" />
            <input value={form.statusCode} onChange={(event) => setForm({ ...form, statusCode: event.target.value })} placeholder="* or 200" className="w-24 rounded-md border border-border bg-background px-2 py-1 text-sm" aria-label="Status code" />
          </div>
          <textarea value={form.properties} onChange={(event) => setForm({ ...form, properties: event.target.value })} rows={4} className="mt-2 w-full rounded-md border border-border bg-background p-2 font-mono text-xs" aria-label="Properties JSON" />
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
            <input value={versionName} onChange={(event) => setVersionName(event.target.value)} placeholder="v1" className="rounded-md border border-border bg-background px-2 py-1 text-sm" aria-label="Version name" />
            <Button variant="outline" disabled={busy} onClick={createVersion}>Freeze version</Button>
            <select value={stageName} onChange={(event) => setStageName(event.target.value)} className="rounded-md border border-border bg-background px-2 py-1 text-sm" aria-label="Stage">
              <option value="">Pick a stage…</option>
              {(stages ?? []).map((entry) => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
            </select>
            <Button variant="outline" disabled={busy} onClick={associate}>Pin version to stage</Button>
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
}
