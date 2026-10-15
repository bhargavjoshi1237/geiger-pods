"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, Globe, Network, Pencil, Plus, Radio, Trash2, Upload, Zap } from "lucide-react";
import { DataTable, EmptyState, Field, LoadingArea, ScreenHeader, SearchInput, StatsBar, Toolbar } from "@/components/internal/shared/screen_kit";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { useWorkspaceNav } from "@/context/workspace-nav-context";
import { MainScreenWrapper } from "@/components/internal/shared/screen_wrappers";
import { ListPagination, usePagination } from "@/components/internal/shared/pagination";
import FilterDropdown from "../overview/filter_dropdown";

const PROTOCOLS = [
  {
    value: "REST",
    title: "REST",
    summary: "Full-featured APIs with resources, methods, models and usage plans.",
    icon: Globe,
  },
  {
    value: "HTTP",
    title: "HTTP",
    summary: "Low-latency APIs with simple routes, JWT authorizers and auto-deploy.",
    icon: Zap,
  },
  {
    value: "WEBSOCKET",
    title: "WebSocket",
    summary: "Persistent two-way connections with $connect, $disconnect and custom routes.",
    icon: Radio,
  },
];

export async function fetchApis(projectId, path = "", options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/apis${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

function CreateApiDialog({ open, onOpenChange, onCreated }) {
  const { project } = useProject();
  const [protocol, setProtocol] = useState("REST");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const body = { name: name.trim(), description: description.trim() || undefined, protocol };
      if (protocol === "HTTP" && target.trim()) body.quickCreate = { target: target.trim() };
      const created = await fetchApis(project.id, "", { method: "POST", body: JSON.stringify(body) });
      toast.success(`Created ${created.name}.`);
      if (created.quickCreatePending) toast.warning(created.quickCreatePending);
      onOpenChange(false);
      setName("");
      setDescription("");
      setTarget("");
      await onCreated();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-xl bg-background">
      <DialogHeader>
        <DialogTitle>New API</DialogTitle>
        <DialogDescription>Pick a protocol. Names are unique per project.</DialogDescription>
      </DialogHeader>
      <form className="space-y-4" onSubmit={submit}>
        <div className="grid gap-2">
          {PROTOCOLS.map((entry) => {
            const Icon = entry.icon;
            const selected = protocol === entry.value;
            return <Button
              key={entry.value}
              type="button"
              variant="outline"
              onClick={() => setProtocol(entry.value)}
              className={`h-auto w-full items-start justify-start gap-3 whitespace-normal p-3 text-left font-normal ${selected ? "border-primary" : ""}`}
              aria-pressed={selected}
            >
              <Icon className="mt-0.5 size-4 shrink-0" />
              <span>
                <span className="block text-sm font-medium">{entry.title}</span>
                <span className="block text-xs text-muted-foreground">{entry.summary}</span>
              </span>
            </Button>;
          })}
        </div>
        <Field label="Name" htmlFor="api-name">
          <Input id="api-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="pets-api" required maxLength={128} autoFocus />
        </Field>
        <Field label="Description (optional)" htmlFor="api-description">
          <Textarea id="api-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={2} maxLength={1024} />
        </Field>
        {protocol === "HTTP" ? <Field label="Backend URL (optional)" htmlFor="api-target" hint="Creates a $default route that proxies to this URL.">
          <Input id="api-target" value={target} onChange={(event) => setTarget(event.target.value)} placeholder="https://api.example.com" inputMode="url" />
        </Field> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create API"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

const PROTOCOL_FILTER_OPTIONS = [
  { value: "all", label: "All protocols" },
  ...PROTOCOLS.map((entry) => ({ value: entry.value, label: entry.title })),
];

const PROTOCOL_LABEL = Object.fromEntries(PROTOCOLS.map((entry) => [entry.value, entry.title]));

const formatDate = (value) => (value ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");

const apiRef = (api) => api.publicId ?? api.id;

function DeleteApiDialog({ api, onOpenChange, onDeleted }) {
  const { project } = useProject();
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      await fetchApis(project.id, `/${encodeURIComponent(apiRef(api))}`, { method: "DELETE" });
      toast.success(`Deleted ${api.name}.`);
      onOpenChange(false);
      await onDeleted();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open={!!api} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Delete API</DialogTitle>
        <DialogDescription>
          Delete <span className="font-medium text-foreground">{api?.name}</span>? Its stages stop serving traffic. This can&apos;t be undone.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button className="bg-red-500/90 text-white hover:bg-red-500" disabled={busy} onClick={remove}>
          <Trash2 className="size-4" />{busy ? "Deleting…" : "Delete"}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function ApiListScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const { navigate } = useWorkspaceNav();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [search, setSearch] = useState("");
  const [protocol, setProtocol] = useState("all");
  const writable = can("pods.api.create");
  const deletable = can("pods.api.delete");

  const refresh = useCallback(async () => {
    try {
      const data = await fetchApis(project.id, "");
      setState({ status: "ready", items: data.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [project.id]);

  useEffect(() => {
    let alive = true;
    fetchApis(project.id, "").then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id]);

  const apis = state.items;
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return apis.filter((api) => {
      if (protocol !== "all" && api.protocol !== protocol) return false;
      return !query || `${api.name} ${api.description ?? ""} ${api.publicId ?? ""}`.toLowerCase().includes(query);
    });
  }, [apis, search, protocol]);

  const pager = usePagination(filtered, { resetKey: `${search}|${protocol}` });

  const stats = useMemo(() => {
    const count = (value) => apis.filter((api) => api.protocol === value).length;
    return [
      { label: "Total APIs", value: String(apis.length), footer: "Across this project" },
      { label: "REST", value: String(count("REST")), footer: "Resources and methods" },
      { label: "HTTP", value: String(count("HTTP")), footer: "Routes and auto-deploy" },
      { label: "WebSocket", value: String(count("WEBSOCKET")), footer: "Persistent connections" },
    ];
  }, [apis]);

  const openApi = (api) => navigate(`apis/${encodeURIComponent(apiRef(api))}/overview`);

  const copyId = (api) => {
    navigator.clipboard?.writeText(apiRef(api)).then(
      () => toast.success("API ID copied."),
      () => toast.error("Couldn't copy the API ID."),
    );
  };

  const columns = [
    {
      key: "name",
      header: "API",
      render: (api) => <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate font-medium text-foreground">{api.name}</span>
        <span className="block max-w-[26rem] truncate text-xs text-text-secondary">{api.description || "No description"}</span>
      </div>,
    },
    { key: "protocol", header: "Protocol", render: (api) => <Badge variant="outline">{PROTOCOL_LABEL[api.protocol] ?? api.protocol}</Badge> },
    { key: "endpoint", header: "Endpoint", render: (api) => <span className="text-sm text-text-secondary">{api.endpointType}</span> },
    { key: "id", header: "API ID", render: (api) => <span className="font-mono text-xs text-text-secondary">{api.publicId}</span> },
    { key: "updated", header: "Updated", render: (api) => <span className="text-sm tabular-nums text-text-secondary">{formatDate(api.updatedAt ?? api.createdAt)}</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (api) => <ActionMenu
        label={`Actions for ${api.name}`}
        items={[
          { icon: Pencil, label: "Open", onSelect: () => openApi(api) },
          { icon: Copy, label: "Copy API ID", onSelect: () => copyId(api) },
          deletable && { separator: true },
          deletable && { icon: Trash2, label: "Delete", destructive: true, onSelect: () => setDeleteTarget(api) },
        ]}
      />,
    },
  ];

  const createButton = writable ? <Button onClick={() => setCreating(true)}><Plus className="size-4" />New API</Button> : null;

  return <MainScreenWrapper>
    <ScreenHeader
      title="APIs"
      description="REST, HTTP and WebSocket APIs. Routes and resources are the draft; stages serve immutable deployments."
      actions={<div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled title="Import from an API's Import / Export tab"><Upload className="size-4" />Import OpenAPI</Button>
        {createButton}
      </div>}
    />

    <StatsBar stats={stats} />

    <Toolbar>
      <FilterDropdown label="Protocol" value={protocol} onValueChange={setProtocol} options={PROTOCOL_FILTER_OPTIONS} />
      <SearchInput value={search} onChange={setSearch} placeholder="Search APIs, descriptions, IDs…" />
    </Toolbar>

    {state.status === "loading" ? <LoadingArea label="Loading APIs" /> : null}
    {state.status === "error" ? <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={Network}
      title="APIs unavailable"
      description={state.error}
      action={<Button variant="outline" onClick={() => { setState({ status: "loading", items: [], error: null }); refresh(); }}>Retry</Button>}
    /></div> : null}
    {state.status === "ready" ? <div className="space-y-5">
      <DataTable
        columns={columns}
        data={pager.pageItems}
        getRowKey={(api) => api.id}
        onRowClick={openApi}
        empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
          icon={Network}
          title={apis.length ? "No APIs match your filters" : "No APIs yet"}
          description={apis.length
            ? "Try clearing the search or protocol filter."
            : "REST APIs model resources and methods. HTTP APIs use simple routes. WebSocket APIs stay connected. Create your first API to begin."}
          action={apis.length ? null : createButton}
        /></div>}
      />
      <ListPagination {...pager} itemLabel="APIs" />
    </div> : null}

    {writable ? <CreateApiDialog open={creating} onOpenChange={setCreating} onCreated={refresh} /> : null}
    {deletable ? <DeleteApiDialog api={deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }} onDeleted={refresh} /> : null}
  </MainScreenWrapper>;
}
