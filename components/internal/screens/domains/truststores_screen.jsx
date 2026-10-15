"use client";

// Trust stores: client-CA PEM bundles for mutual TLS. The list shows cert
// counts and expiry warnings; the edit page (opened in place via ?record=)
// shows the current bundle's warnings and its version history, and uploads a
// replacement bundle as a new version.

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Copy, History, LayoutDashboard, Loader2, LockKeyhole, Pencil, Plus, ShieldCheck, Upload } from "lucide-react";
import {
  DataTable, EmptyState, Field, LoadingArea, ScreenHeader, SearchInput, SectionCard, StatsBar, StatusPill, Toolbar,
} from "@/components/internal/shared/screen_kit";
import { MainScreenWrapper } from "@/components/internal/shared/screen_wrappers";
import { ListPagination, usePagination } from "@/components/internal/shared/pagination";
import { EditorShell } from "@/components/internal/shared/editor_shell";
import FilterDropdown from "@/components/internal/screens/overview/filter_dropdown";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { useRecordParam } from "@/lib/hooks/use-record-param";

async function api(projectId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/truststores${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

const HEALTH_MAP = {
  healthy: { label: "Healthy", variant: "success", dotClass: "bg-emerald-400" },
  warnings: { label: "Warnings", variant: "warning", dotClass: "bg-amber-400" },
};

const HEALTH_FILTER_OPTIONS = [
  { value: "all", label: "All Statuses" },
  { value: "healthy", label: "Healthy" },
  { value: "warnings", label: "Warnings" },
];

const healthOf = (entry) => ((entry.warnings ?? []).length > 0 ? "warnings" : "healthy");

const formatDate = (value) => (value ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

async function copyText(value, label) {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied.`);
  } catch {
    toast.error("Couldn't copy to the clipboard.");
  }
}

const cancelButtonClass = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";
const primaryButtonClass = "bg-primary text-primary-foreground hover:bg-primary/90";

function Warnings({ warnings }) {
  if (!warnings?.length) return null;
  return <ul className="space-y-1.5">
    {warnings.map((warning) => <li key={warning} className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{warning}
    </li>)}
  </ul>;
}

// --- Dialogs --------------------------------------------------------------------

function CreateTruststoreDialog({ open, onOpenChange, projectId, onCreated }) {
  const [name, setName] = useState("");
  const [bundle, setBundle] = useState("");
  const [busy, setBusy] = useState(false);

  const close = () => {
    onOpenChange(false);
    setName("");
    setBundle("");
  };

  const submit = async () => {
    if (!name.trim()) {
      toast.error("Give the trust store a name first.");
      return;
    }
    setBusy(true);
    try {
      const created = await api(projectId, "", { method: "POST", body: JSON.stringify({ name, pemBundle: bundle }) });
      toast.success(`"${name}" created.`);
      close();
      await onCreated(created);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open={open} onOpenChange={(next) => { if (!next) close(); else onOpenChange(true); }}>
    <DialogContent className="max-w-xl bg-background">
      <DialogHeader>
        <DialogTitle>New Trust Store</DialogTitle>
        <DialogDescription>Upload the CA certificates that sign your clients&apos; certificates.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <Field label="Name" htmlFor="truststore-name">
          <Input id="truststore-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="client-ca" autoFocus maxLength={128} />
        </Field>
        <Field label="PEM bundle" htmlFor="truststore-bundle" hint="Up to 1,000 certificates and 1 MB. Certificates are public data.">
          <Textarea id="truststore-bundle" value={bundle} onChange={(event) => setBundle(event.target.value)} rows={8} spellCheck={false} className="font-mono text-xs" placeholder="-----BEGIN CERTIFICATE-----" />
        </Field>
      </div>
      <DialogFooter>
        <Button variant="outline" className={cancelButtonClass} onClick={close}>Cancel</Button>
        <Button className={primaryButtonClass} disabled={busy} onClick={submit}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Create Trust Store
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function UploadVersionDialog({ truststore, onOpenChange, projectId, onUploaded }) {
  const [bundle, setBundle] = useState("");
  const [busy, setBusy] = useState(false);

  const close = () => {
    onOpenChange(false);
    setBundle("");
  };

  const submit = async () => {
    if (!bundle.trim()) {
      toast.error("Paste a PEM bundle first.");
      return;
    }
    setBusy(true);
    try {
      const updated = await api(projectId, `/${encodeURIComponent(truststore.id)}`, { method: "POST", body: JSON.stringify({ pemBundle: bundle }) });
      toast.success(`Uploaded version ${updated.version}.`);
      close();
      await onUploaded(updated);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open={!!truststore} onOpenChange={(next) => { if (!next) close(); }}>
    <DialogContent className="max-w-xl bg-background">
      <DialogHeader>
        <DialogTitle>Upload New Version</DialogTitle>
        <DialogDescription>
          Replaces the bundle for <span className="font-medium text-foreground">{truststore?.name}</span>. Domains using it pick up the new version; earlier versions stay in the history.
        </DialogDescription>
      </DialogHeader>
      <Field label="PEM bundle" htmlFor="truststore-new-bundle" hint="Up to 1,000 certificates and 1 MB.">
        <Textarea id="truststore-new-bundle" value={bundle} onChange={(event) => setBundle(event.target.value)} rows={8} spellCheck={false} className="font-mono text-xs" placeholder="-----BEGIN CERTIFICATE-----" autoFocus />
      </Field>
      <DialogFooter>
        <Button variant="outline" className={cancelButtonClass} onClick={close}>Cancel</Button>
        <Button className={primaryButtonClass} disabled={busy} onClick={submit}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}Upload Version
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

// --- Edit page ------------------------------------------------------------------

const TRUSTSTORE_NAV = [
  { key: "overview", label: "Overview", icon: LayoutDashboard, desc: "The current bundle and anything that needs attention." },
  { key: "versions", label: "Version History", icon: History, desc: "Every bundle uploaded to this trust store." },
];

function TruststoreEditPage({ projectId, truststore, canWrite, reloadKey, onBack, onUpload }) {
  const [detail, setDetail] = useState({ status: "loading", versions: [], error: null });

  const loadDetail = useCallback(() => api(projectId, `/${encodeURIComponent(truststore.id)}`).then(
    (data) => setDetail({ status: "ready", versions: data.versions ?? [], error: null }),
    (error) => setDetail({ status: "error", versions: [], error: error.message }),
  ), [projectId, truststore.id]);

  useEffect(() => {
    let alive = true;
    api(projectId, `/${encodeURIComponent(truststore.id)}`).then(
      (data) => { if (alive) setDetail({ status: "ready", versions: data.versions ?? [], error: null }); },
      (error) => { if (alive) setDetail({ status: "error", versions: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [projectId, truststore.id, reloadKey]);

  const versions = [...detail.versions].sort((a, b) => b.version - a.version);
  const health = healthOf(truststore);

  const versionColumns = [
    {
      key: "version",
      header: "Version",
      render: (entry) => <div className="flex items-center gap-2">
        <span className="font-medium tabular-nums text-foreground">v{entry.version}</span>
        {entry.version === truststore.version ? <Badge variant="success">Current</Badge> : null}
      </div>,
    },
    { key: "certs", header: "Certificates", align: "right", className: "text-right", render: (entry) => <span className="text-sm tabular-nums text-text-secondary">{entry.certCount}</span> },
    {
      key: "warnings",
      header: "Warnings",
      render: (entry) => ((entry.warnings ?? []).length ? <Warnings warnings={entry.warnings} /> : <span className="text-xs text-text-tertiary">None</span>),
    },
  ];

  return <EditorShell
    back={{ label: "All Trust Stores", onClick: onBack }}
    title={truststore.name}
    status={health}
    statusMap={HEALTH_MAP}
    badges={<>
      <Badge variant="outline">v{truststore.version}</Badge>
      <Badge variant="outline">{plural(truststore.certCount, "certificate")}</Badge>
    </>}
    actions={canWrite ? <Button className={primaryButtonClass} onClick={() => onUpload(truststore)}><Upload className="h-4 w-4" />Upload New Version</Button> : null}
    nav={TRUSTSTORE_NAV}
  >
    {({ active }) => <div>
      <div hidden={active !== "overview"} className="space-y-6">
        {(truststore.warnings ?? []).length ? <SectionCard title="Warnings" description="Fix these in the bundle and upload a new version.">
          <Warnings warnings={truststore.warnings} />
        </SectionCard> : null}
        <SectionCard title="Details">
          <dl className="grid gap-4 sm:grid-cols-2">
            <div><dt className="text-xs text-text-secondary">Status</dt><dd className="mt-1"><StatusPill status={health} map={HEALTH_MAP} /></dd></div>
            <div><dt className="text-xs text-text-secondary">Certificates</dt><dd className="mt-1 text-sm tabular-nums text-foreground">{truststore.certCount}</dd></div>
            <div><dt className="text-xs text-text-secondary">Current version</dt><dd className="mt-1 text-sm tabular-nums text-foreground">v{truststore.version}</dd></div>
            <div><dt className="text-xs text-text-secondary">Last updated</dt><dd className="mt-1 text-sm text-foreground">{formatDate(truststore.updatedAt ?? truststore.createdAt)}</dd></div>
            <div className="min-w-0 sm:col-span-2">
              <dt className="text-xs text-text-secondary">Trust store ID</dt>
              <dd className="mt-1 flex min-w-0 items-center gap-1.5">
                <span className="truncate font-mono text-xs text-foreground">{truststore.id}</span>
                <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label="Copy trust store ID" onClick={() => copyText(truststore.id, "Trust store ID")}>
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </dd>
            </div>
          </dl>
        </SectionCard>
      </div>
      <div hidden={active !== "versions"}>
        {detail.status === "loading" ? <LoadingArea label="Loading version history" /> : null}
        {detail.status === "error" ? <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
          icon={History}
          title="Version history unavailable"
          description={detail.error}
          action={<Button variant="outline" onClick={() => { setDetail({ status: "loading", versions: [], error: null }); loadDetail(); }}>Retry</Button>}
        /></div> : null}
        {detail.status === "ready" ? <DataTable
          columns={versionColumns}
          data={versions}
          getRowKey={(entry) => entry.version}
          empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={History} title="No versions recorded" description="Upload a bundle to start the history." /></div>}
        /> : null}
      </div>
    </div>}
  </EditorShell>;
}

// --- Screen ---------------------------------------------------------------------

export function TruststoresScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [creating, setCreating] = useState(false);
  const [uploadTarget, setUploadTarget] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [search, setSearch] = useState("");
  const [health, setHealth] = useState("all");
  const [recordId, setRecordId] = useRecordParam();
  const projectId = project?.id;
  const allowed = can("pods.domains.view");
  const canWrite = can("pods.trust_store.write");

  // Refreshes in place (no loading flash) so an open edit page stays put.
  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await api(projectId, "");
      setState({ status: "ready", items: data.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return undefined;
    let alive = true;
    api(projectId, "").then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [projectId]);

  const truststores = state.items;
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return truststores.filter((entry) => {
      if (health !== "all" && healthOf(entry) !== health) return false;
      return !query || `${entry.name} ${entry.id}`.toLowerCase().includes(query);
    });
  }, [truststores, search, health]);

  const pager = usePagination(filtered, { resetKey: `${search}|${health}` });

  const stats = useMemo(() => [
    { label: "Trust stores", value: String(truststores.length), footer: "Across this project" },
    { label: "Certificates", value: String(truststores.reduce((sum, entry) => sum + (entry.certCount ?? 0), 0)), footer: "Trusted client CAs" },
    { label: "With warnings", value: String(truststores.filter((entry) => healthOf(entry) === "warnings").length), footer: "Need attention" },
  ], [truststores]);

  const dialogs = canWrite ? <>
    <CreateTruststoreDialog
      open={creating}
      onOpenChange={setCreating}
      projectId={projectId}
      onCreated={async (created) => {
        await refresh();
        if (created?.id) setRecordId(created.id);
      }}
    />
    <UploadVersionDialog
      truststore={uploadTarget}
      onOpenChange={(open) => { if (!open) setUploadTarget(null); }}
      projectId={projectId}
      onUploaded={async () => {
        await refresh();
        setReloadKey((key) => key + 1);
      }}
    />
  </> : null;

  const createButton = canWrite ? <Button className={primaryButtonClass} onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New Trust Store</Button> : null;

  const header = <ScreenHeader
    title="Trust Stores"
    description="Client certificate authority bundles for mutual TLS. Attach one to a custom domain to require client certificates."
    actions={allowed ? createButton : null}
  />;

  if (!allowed) {
    return <MainScreenWrapper>
      {header}
      <div className="rounded-xl border border-border bg-surface-subtle">
        <EmptyState icon={LockKeyhole} title="Access unavailable" description="Your current team access does not allow this screen." />
      </div>
    </MainScreenWrapper>;
  }

  const openTruststore = recordId ? truststores.find((entry) => entry.id === recordId) : null;
  if (openTruststore) {
    return <>
      <TruststoreEditPage
        key={openTruststore.id}
        projectId={projectId}
        truststore={openTruststore}
        canWrite={canWrite}
        reloadKey={reloadKey}
        onBack={() => setRecordId(null)}
        onUpload={setUploadTarget}
      />
      {dialogs}
    </>;
  }

  const columns = [
    {
      key: "name",
      header: "Name",
      render: (entry) => <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-card text-muted-foreground">
          <ShieldCheck className="h-4 w-4" />
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-medium text-foreground">{entry.name}</span>
          {(entry.warnings ?? []).length
            ? <span className="truncate text-xs text-amber-600 dark:text-amber-400">{entry.warnings[0]}{entry.warnings.length > 1 ? ` (+${entry.warnings.length - 1} more)` : ""}</span>
            : <span className="truncate text-xs text-text-secondary">No warnings</span>}
        </div>
      </div>,
    },
    { key: "version", header: "Version", render: (entry) => <Badge variant="neutral">v{entry.version}</Badge> },
    { key: "status", header: "Status", render: (entry) => <StatusPill status={healthOf(entry)} map={HEALTH_MAP} /> },
    { key: "certs", header: "Certificates", align: "right", className: "text-right", render: (entry) => <span className="text-sm tabular-nums text-text-secondary">{entry.certCount}</span> },
    { key: "updated", header: "Updated", render: (entry) => <span className="text-sm tabular-nums text-text-secondary">{formatDate(entry.updatedAt ?? entry.createdAt)}</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (entry) => <ActionMenu
        label={`Actions for ${entry.name}`}
        items={[
          { icon: Pencil, label: "Open", onSelect: () => setRecordId(entry.id) },
          canWrite && { icon: Upload, label: "Upload new version", onSelect: () => setUploadTarget(entry) },
          { icon: Copy, label: "Copy ID", onSelect: () => copyText(entry.id, "Trust store ID") },
        ]}
      />,
    },
  ];

  return <MainScreenWrapper>
    {header}

    <StatsBar stats={stats} columns={3} />

    <Toolbar>
      <div className="flex flex-wrap items-center gap-2">
        <FilterDropdown label="Status" value={health} onValueChange={setHealth} options={HEALTH_FILTER_OPTIONS} height="h-9" />
      </div>
      <SearchInput value={search} onChange={setSearch} placeholder="Search trust stores…" />
    </Toolbar>

    {state.status === "loading" ? <LoadingArea label="Loading trust stores" /> : null}
    {state.status === "error" ? <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={ShieldCheck}
      title="Could not load trust stores"
      description={state.error}
      action={<Button variant="outline" onClick={() => { setState({ status: "loading", items: [], error: null }); refresh(); }}>Retry</Button>}
    /></div> : null}
    {state.status === "ready" ? <div className="space-y-5">
      <DataTable
        columns={columns}
        data={pager.pageItems}
        getRowKey={(entry) => entry.id}
        onRowClick={(entry) => setRecordId(entry.id)}
        empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
          icon={ShieldCheck}
          title={truststores.length ? "No trust stores match your filters" : "No trust stores yet"}
          description={truststores.length
            ? "Try clearing the search or status filter."
            : "Upload a PEM bundle of client CAs to enable mTLS on a custom domain."}
          action={truststores.length ? null : createButton}
        /></div>}
      />
      <ListPagination {...pager} itemLabel="trust stores" />
    </div> : null}

    {dialogs}
  </MainScreenWrapper>;
}
