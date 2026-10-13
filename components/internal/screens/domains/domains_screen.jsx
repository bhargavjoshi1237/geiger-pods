"use client";

// Custom domains: list with status, endpoint type and certificate expiry; the
// edit page (opened in place via ?record=) covers DNS records and ownership
// verification, API mappings with a longest-prefix tester, routing rules and
// the mTLS trust store.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Copy, ExternalLink, Globe, Info, LayoutDashboard, Loader2, LockKeyhole, Pencil, Plus, RefreshCw, Route,
  ShieldCheck, Split, Trash2,
} from "lucide-react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { WorkspaceLink } from "@/context/workspace-nav-context";
import { useRecordParam } from "@/lib/hooks/use-record-param";

async function api(projectId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/domains${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

const DOMAIN_STATUS_MAP = {
  AVAILABLE: { label: "Available", variant: "success", dotClass: "bg-emerald-400" },
  PENDING_VERIFICATION: { label: "Pending verification", variant: "warning", dotClass: "bg-amber-400" },
  PENDING_CERTIFICATE: { label: "Pending certificate", variant: "info", dotClass: "bg-sky-400" },
  UPDATING: { label: "Updating", variant: "info", dotClass: "bg-sky-400" },
  FAILED: { label: "Failed", variant: "danger", dotClass: "bg-red-400" },
};

const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "All Statuses" },
  ...Object.entries(DOMAIN_STATUS_MAP).map(([value, meta]) => ({ value, label: meta.label })),
];

const ENDPOINT_LABEL = { REGIONAL: "Regional", EDGE: "Edge", PRIVATE: "Private" };

const ENDPOINT_FILTER_OPTIONS = [
  { value: "all", label: "All Endpoint Types" },
  ...Object.entries(ENDPOINT_LABEL).map(([value, label]) => ({ value, label })),
];

const ROUTING_MODE_LABEL = {
  API_MAPPING_ONLY: "API mappings only",
  ROUTING_RULE_THEN_API_MAPPING: "Routing rules, then API mappings",
  ROUTING_RULE_ONLY: "Routing rules only",
};

const PENDING = new Set(["PENDING_VERIFICATION", "PENDING_CERTIFICATE", "UPDATING"]);

const formatDate = (value) => (value ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");

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
const destructiveButtonClass = "bg-red-500/90 text-white hover:bg-red-500";

// --- Shared bits ----------------------------------------------------------------

function Notice({ icon: Icon = Info, children }) {
  return <div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface-card px-3.5 py-2.5 text-xs leading-relaxed text-text-secondary">
    <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-tertiary" />
    <p>{children}</p>
  </div>;
}

function CopyValue({ value, label }) {
  return <div className="flex min-w-0 items-center gap-1.5">
    <span className="truncate font-mono text-xs text-foreground" title={value}>{value || "—"}</span>
    {value ? <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => copyText(value, label)}>
      <Copy className="h-3.5 w-3.5" />
    </Button> : null}
  </div>;
}

function Facts({ items }) {
  return <dl className="grid gap-4 sm:grid-cols-2">
    {items.map((item) => <div key={item.label} className="min-w-0">
      <dt className="text-xs text-text-secondary">{item.label}</dt>
      <dd className="mt-1 text-sm text-foreground">{item.value}</dd>
    </div>)}
  </dl>;
}

function ConfirmDialog({ open, onOpenChange, title, children, confirmLabel, busy, onConfirm }) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{children}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button className={destructiveButtonClass} disabled={busy} onClick={onConfirm}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}{confirmLabel}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

// --- Overview: DNS records, verification, details ------------------------------

const RECORD_PURPOSE = {
  TXT: "Proves you own the domain.",
  CNAME: "Points traffic at the gateway.",
};

function OverviewSection({ projectId, domain, canWrite, verifying, onVerify, onDelete }) {
  const [detail, setDetail] = useState({ status: "loading", records: [], error: null });

  const loadRecords = useCallback(() => api(projectId, `/${domain.id}`).then(
    (data) => setDetail({ status: "ready", records: data.dnsRecords ?? [], error: null }),
    (error) => setDetail({ status: "error", records: [], error: error.message }),
  ), [projectId, domain.id]);

  useEffect(() => {
    let alive = true;
    api(projectId, `/${domain.id}`).then(
      (data) => { if (alive) setDetail({ status: "ready", records: data.dnsRecords ?? [], error: null }); },
      (error) => { if (alive) setDetail({ status: "error", records: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [projectId, domain.id]);

  return <div className="space-y-6">
    <SectionCard title="DNS records" description="Add these records at your DNS provider, then verify ownership." bodyPadding={false}>
      {detail.status === "loading" ? <LoadingArea className="py-10" label="Loading DNS records" /> : null}
      {detail.status === "error" ? <EmptyState
        icon={Globe}
        title="DNS records unavailable"
        description={detail.error}
        action={<Button variant="outline" onClick={() => { setDetail({ status: "loading", records: [], error: null }); loadRecords(); }}>Retry</Button>}
      /> : null}
      {detail.status === "ready" ? <div className="divide-y divide-border">
        {detail.records.map((record) => <div key={`${record.type}-${record.name}`} className="space-y-1 px-5 py-4">
          <div className="flex items-center gap-2">
            <Badge variant="outline">{record.type}</Badge>
            <span className="text-xs text-text-secondary">{RECORD_PURPOSE[record.type] ?? ""}</span>
          </div>
          <div className="flex items-center justify-between gap-4 pt-1">
            <span className="text-sm text-text-secondary">Name</span>
            <CopyValue value={record.name} label="Record name" />
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-text-secondary">Value</span>
            <CopyValue value={record.value} label="Record value" />
          </div>
          {record.note ? <p className="pt-1 text-xs text-text-tertiary">{record.note}</p> : null}
        </div>)}
      </div> : null}
      <div className="border-t border-border px-5 py-4">
        {domain.status === "AVAILABLE" ? <Notice icon={ShieldCheck}>This domain is verified and serving traffic with an active certificate.</Notice> : null}
        {domain.status === "PENDING_CERTIFICATE" ? <Notice icon={ShieldCheck}>Ownership is verified. The domain goes live once its certificate is in place.</Notice> : null}
        {domain.status !== "AVAILABLE" && canWrite ? <div className={domain.status === "PENDING_CERTIFICATE" ? "mt-4" : undefined}>
          <Button className={primaryButtonClass} disabled={verifying} onClick={() => onVerify(domain)}>
            {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {verifying ? "Verifying…" : "Verify Record"}
          </Button>
          <p className="mt-3 text-xs text-text-tertiary">
            DNS changes can take up to 48 hours to propagate. Check again once the TXT record resolves.
          </p>
        </div> : null}
      </div>
    </SectionCard>

    <SectionCard title="Details">
      <Facts items={[
        { label: "Status", value: <StatusPill status={domain.status} map={DOMAIN_STATUS_MAP} /> },
        { label: "Endpoint type", value: ENDPOINT_LABEL[domain.endpointType] ?? domain.endpointType },
        { label: "IP address type", value: domain.ipAddressType === "dualstack" ? "Dual-stack" : "IPv4" },
        { label: "Security policy", value: <span className="font-mono text-xs">{domain.securityPolicy}</span> },
        { label: "Certificate", value: domain.certificateMode === "imported" ? "Imported" : "Managed" },
        { label: "Certificate expires", value: domain.certificateExpiresAt ? formatDate(domain.certificateExpiresAt) : "Not issued yet" },
        { label: "Routing mode", value: ROUTING_MODE_LABEL[domain.routingMode] ?? domain.routingMode },
        { label: "Target hostname", value: <CopyValue value={domain.targetHostname} label="Target hostname" /> },
        { label: "Domain ID", value: <CopyValue value={domain.id} label="Domain ID" /> },
        { label: "Created", value: formatDate(domain.createdAt) },
      ]} />
    </SectionCard>

    {canWrite ? <SectionCard title="Danger zone" description="Deleting a domain stops it serving traffic and removes its mappings.">
      <Button className={destructiveButtonClass} onClick={() => onDelete(domain)}><Trash2 className="h-4 w-4" />Delete Domain</Button>
    </SectionCard> : null}
  </div>;
}

// --- API mappings ---------------------------------------------------------------

function MappingsSection({ projectId, domain, canWrite }) {
  const [mappings, setMappings] = useState({ status: "loading", items: [] });
  const [form, setForm] = useState({ apiId: "", stage: "prod", basePath: "" });
  const [preview, setPreview] = useState("/pets");
  const [adding, setAdding] = useState(false);
  const [removeTarget, setRemoveTarget] = useState(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api(projectId, `/${domain.id}/mappings`);
      setMappings({ status: "ready", items: data.items ?? [] });
    } catch (error) {
      toast.error(error.message);
    }
  }, [projectId, domain.id]);

  useEffect(() => {
    let alive = true;
    api(projectId, `/${domain.id}/mappings`).then(
      (data) => { if (alive) setMappings({ status: "ready", items: data.items ?? [] }); },
      (error) => { if (alive) { setMappings({ status: "ready", items: [] }); toast.error(error.message); } },
    );
    return () => { alive = false; };
  }, [projectId, domain.id]);

  const items = mappings.items;
  const longest = [...items].sort((a, b) => b.basePath.length - a.basePath.length)
    .find((entry) => entry.basePath === "" || preview === `/${entry.basePath}` || preview.startsWith(`/${entry.basePath}/`));

  const add = async () => {
    setAdding(true);
    try {
      await api(projectId, `/${domain.id}/mappings`, { method: "POST", body: JSON.stringify(form) });
      toast.success("Mapping added.");
      setForm({ apiId: "", stage: "prod", basePath: "" });
      await load();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setAdding(false);
    }
  };

  const remove = async () => {
    setRemoving(true);
    try {
      await api(projectId, `/${domain.id}/mappings/${removeTarget.id}`, { method: "DELETE" });
      toast.success("Mapping removed.");
      setRemoveTarget(null);
      await load();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setRemoving(false);
    }
  };

  const columns = [
    { key: "basePath", header: "Base path", render: (entry) => <span className="font-mono text-sm text-foreground">/{entry.basePath}</span> },
    { key: "api", header: "API", render: (entry) => <span className="font-mono text-xs text-text-secondary">{entry.apiId}</span> },
    { key: "stage", header: "Stage", render: (entry) => <Badge variant="neutral">{entry.stage}</Badge> },
    canWrite && {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (entry) => <ActionMenu
        label={`Actions for /${entry.basePath}`}
        items={[{ icon: Trash2, label: "Remove", variant: "destructive", onSelect: () => setRemoveTarget(entry) }]}
      />,
    },
  ].filter(Boolean);

  return <div className="space-y-6">
    {mappings.status === "loading" ? <LoadingArea panel label="Loading mappings" /> : <DataTable
      columns={columns}
      data={items}
      getRowKey={(entry) => entry.id}
      empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
        icon={Route}
        title="No mappings yet"
        description="Map a base path to an API stage to start serving it from this domain."
      /></div>}
    />}

    {canWrite ? <SectionCard title="Add mapping" description="Leave the base path empty to map the whole domain.">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="API ID" htmlFor="domain-mapping-api">
          <Input id="domain-mapping-api" value={form.apiId} onChange={(event) => setForm({ ...form, apiId: event.target.value })} placeholder="api public id" />
        </Field>
        <Field label="Stage" htmlFor="domain-mapping-stage">
          <Input id="domain-mapping-stage" value={form.stage} onChange={(event) => setForm({ ...form, stage: event.target.value })} />
        </Field>
        <Field label="Base path" htmlFor="domain-mapping-base">
          <Input id="domain-mapping-base" value={form.basePath} onChange={(event) => setForm({ ...form, basePath: event.target.value })} placeholder="(empty)" />
        </Field>
      </div>
      <div className="mt-4 flex justify-end">
        <Button className={primaryButtonClass} disabled={adding} onClick={add}>
          {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}Add Mapping
        </Button>
      </div>
    </SectionCard> : null}

    <SectionCard title="Test a path" description="See which mapping a request path resolves to. The longest matching base path wins.">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label="Request path" htmlFor="domain-mapping-preview" className="min-w-0 flex-1">
          <Input id="domain-mapping-preview" value={preview} onChange={(event) => setPreview(event.target.value)} className="font-mono" />
        </Field>
        <p className="pb-2 text-sm text-text-secondary">
          {longest ? <>→ <span className="font-mono text-foreground">{longest.apiId}</span> · {longest.stage} <span className="font-mono">(/{longest.basePath})</span></> : "→ 403 Forbidden"}
        </p>
      </div>
    </SectionCard>

    <ConfirmDialog
      open={!!removeTarget}
      onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}
      title="Remove mapping"
      confirmLabel="Remove"
      busy={removing}
      onConfirm={remove}
    >
      Remove <span className="font-medium text-foreground">/{removeTarget?.basePath}</span>? Requests to that base path stop reaching {removeTarget?.apiId} · {removeTarget?.stage}.
    </ConfirmDialog>
  </div>;
}

// --- Routing rules --------------------------------------------------------------

function RulesSection({ projectId, domain, canWrite }) {
  const [rules, setRules] = useState({ status: "loading", items: [] });
  const [removeTarget, setRemoveTarget] = useState(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api(projectId, `/${domain.id}/routing-rules`);
      setRules({ status: "ready", items: data.items ?? [] });
    } catch (error) {
      toast.error(error.message);
    }
  }, [projectId, domain.id]);

  useEffect(() => {
    let alive = true;
    api(projectId, `/${domain.id}/routing-rules`).then(
      (data) => { if (alive) setRules({ status: "ready", items: data.items ?? [] }); },
      (error) => { if (alive) { setRules({ status: "ready", items: [] }); toast.error(error.message); } },
    );
    return () => { alive = false; };
  }, [projectId, domain.id]);

  const remove = async () => {
    setRemoving(true);
    try {
      await api(projectId, `/${domain.id}/routing-rules/${removeTarget.id}`, { method: "DELETE" });
      toast.success("Rule removed.");
      setRemoveTarget(null);
      await load();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setRemoving(false);
    }
  };

  const columns = [
    { key: "priority", header: "Priority", render: (entry) => <span className="text-sm tabular-nums text-foreground">#{entry.priority}</span> },
    { key: "conditions", header: "Conditions", render: (entry) => <code className="block max-w-md break-all font-mono text-xs text-text-secondary">{JSON.stringify(entry.conditions)}</code> },
    {
      key: "target",
      header: "Invokes",
      render: (entry) => <span className="text-sm text-text-secondary">
        <span className="font-mono text-xs text-foreground">{entry.action?.invokeApi?.apiId}</span> · {entry.action?.invokeApi?.stage}
      </span>,
    },
    canWrite && {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (entry) => <ActionMenu
        label={`Actions for rule ${entry.priority}`}
        items={[{ icon: Trash2, label: "Remove", variant: "destructive", onSelect: () => setRemoveTarget(entry) }]}
      />,
    },
  ].filter(Boolean);

  return <div className="space-y-6">
    <SectionCard title="Routing mode" description="How this domain chooses between routing rules and API mappings.">
      <p className="text-sm text-foreground">{ROUTING_MODE_LABEL[domain.routingMode] ?? domain.routingMode}</p>
    </SectionCard>

    {rules.status === "loading" ? <LoadingArea panel label="Loading routing rules" /> : <DataTable
      columns={columns}
      data={rules.items}
      getRowKey={(entry) => entry.id}
      empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
        icon={Split}
        title="No routing rules"
        description="Rules evaluate by ascending priority; the first match wins."
      /></div>}
    />}

    <Notice>Restricted condition headers (authorization, x-forwarded-*, …) are rejected at save. Reorder with gaps via the API.</Notice>

    <ConfirmDialog
      open={!!removeTarget}
      onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}
      title="Remove routing rule"
      confirmLabel="Remove"
      busy={removing}
      onConfirm={remove}
    >
      Remove rule <span className="font-medium text-foreground">#{removeTarget?.priority}</span>? Requests it matched fall through to the next rule or mapping.
    </ConfirmDialog>
  </div>;
}

// --- Mutual TLS -----------------------------------------------------------------

const NO_TRUSTSTORE = "__none__";

function MtlsSection({ projectId, domain, canWrite, onChanged }) {
  const [truststores, setTruststores] = useState({ status: "loading", items: [] });
  const [truststoreId, setTruststoreId] = useState(domain.mtls?.truststoreId ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/truststores`)
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
        return data;
      })
      .then(
        (data) => { if (alive) setTruststores({ status: "ready", items: data?.items ?? [] }); },
        () => { if (alive) setTruststores({ status: "error", items: [] }); },
      );
    return () => { alive = false; };
  }, [projectId]);

  const save = async () => {
    setSaving(true);
    try {
      await api(projectId, `/${domain.id}`, { method: "PATCH", body: JSON.stringify({ mtls: truststoreId ? { truststoreId } : null }) });
      toast.success("mTLS updated.");
      await onChanged();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const options = truststores.items.some((entry) => entry.id === truststoreId) || !truststoreId
    ? truststores.items
    : [{ id: truststoreId, name: truststoreId }, ...truststores.items];

  return <div className="space-y-6">
    <SectionCard
      title="Trust store"
      description="Clients must present a certificate signed by a CA in this trust store."
      action={canWrite ? <Button className={primaryButtonClass} size="sm" disabled={saving} onClick={save}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{saving ? "Saving…" : "Save Changes"}
      </Button> : null}
    >
      <div className="space-y-4">
        {truststores.status === "loading" ? <LoadingArea className="py-6" label="Loading trust stores" /> : null}
        {truststores.status === "ready" ? <Field label="Trust store" hint={truststores.items.length ? undefined : "No trust stores yet."}>
          <Select value={truststoreId || NO_TRUSTSTORE} onValueChange={(value) => setTruststoreId(value === NO_TRUSTSTORE ? "" : value)} disabled={!canWrite}>
            <SelectTrigger className="w-full sm:max-w-md" aria-label="Trust store"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_TRUSTSTORE}>None (mTLS off)</SelectItem>
              {options.map((entry) => <SelectItem key={entry.id} value={entry.id}>
                {entry.name}{entry.version ? ` · v${entry.version} · ${entry.certCount} certs` : ""}
              </SelectItem>)}
            </SelectContent>
          </Select>
        </Field> : null}
        {truststores.status === "error" ? <Field label="Trust store ID" htmlFor="domain-mtls-truststore" hint="Trust stores couldn't be listed. Paste the ID, or leave it empty to turn mTLS off.">
          <Input id="domain-mtls-truststore" value={truststoreId} onChange={(event) => setTruststoreId(event.target.value)} placeholder="truststore uuid" className="font-mono sm:max-w-md" disabled={!canWrite} />
        </Field> : null}
        <Notice>
          mTLS requires the default endpoint to be disabled; saving mTLS while it is enabled shows a warning.
          Manage bundles in <WorkspaceLink section="domains/truststores" className="text-foreground underline-offset-4 hover:underline">Trust Stores</WorkspaceLink>.
        </Notice>
      </div>
    </SectionCard>
  </div>;
}

// --- Edit page ------------------------------------------------------------------

const DOMAIN_NAV = [
  { group: null, items: [{ key: "overview", label: "Overview", icon: LayoutDashboard, desc: "DNS records, ownership verification and certificate details." }] },
  {
    group: "Routing",
    items: [
      { key: "mappings", label: "API Mappings", icon: Route, desc: "Base paths on this domain and the API stage each one serves." },
      { key: "rules", label: "Routing Rules", icon: Split, desc: "Header and path conditions evaluated by priority." },
    ],
  },
  { group: "Security", items: [{ key: "mtls", label: "Mutual TLS", icon: ShieldCheck, desc: "Require client certificates signed by a trust store." }] },
];

function DomainEditPage({ projectId, domain, canWrite, verifying, onBack, onVerify, onChanged, onDelete }) {
  const props = { projectId, domain, canWrite };
  return <EditorShell
    back={{ label: "All Custom Domains", onClick: onBack }}
    title={domain.domainName}
    status={domain.status}
    statusMap={DOMAIN_STATUS_MAP}
    badges={<>
      <Badge variant="outline">{ENDPOINT_LABEL[domain.endpointType] ?? domain.endpointType}</Badge>
      <Badge variant="outline">{domain.certificateMode === "imported" ? "Imported certificate" : "Managed certificate"}</Badge>
    </>}
    meta={domain.statusMessage || undefined}
    nav={DOMAIN_NAV}
  >
    {/* Sections stay mounted so each loads once; switching only toggles visibility. */}
    {({ active }) => <div>
      <div hidden={active !== "overview"}><OverviewSection {...props} verifying={verifying} onVerify={onVerify} onDelete={onDelete} /></div>
      <div hidden={active !== "mappings"}><MappingsSection {...props} /></div>
      <div hidden={active !== "rules"}><RulesSection {...props} /></div>
      <div hidden={active !== "mtls"}><MtlsSection {...props} onChanged={onChanged} /></div>
    </div>}
  </EditorShell>;
}

// --- Create dialog --------------------------------------------------------------

function CreateDomainDialog({ open, onOpenChange, projectId, onCreated }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const close = () => {
    onOpenChange(false);
    setName("");
  };

  const submit = async (event) => {
    event?.preventDefault();
    const domainName = name.trim();
    if (!domainName) {
      toast.error("Enter a domain name first.");
      return;
    }
    setBusy(true);
    try {
      const created = await api(projectId, "", { method: "POST", body: JSON.stringify({ domainName }) });
      toast.success(`"${domainName}" created. Add the DNS records to verify it.`);
      close();
      await onCreated(created);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open={open} onOpenChange={(next) => { if (!next) close(); else onOpenChange(true); }}>
    <DialogContent className="sm:max-w-md bg-background">
      <DialogHeader>
        <DialogTitle>New Custom Domain</DialogTitle>
        <DialogDescription>Enter a hostname you own. You&apos;ll verify it over DNS, then it gets a certificate.</DialogDescription>
      </DialogHeader>
      <form className="grid gap-4" onSubmit={submit}>
        <Field label="Domain name" htmlFor="domain-new-name" hint="Lowercase, e.g. api.example.com. Wildcards like *.example.com work too.">
          <Input id="domain-new-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="api.example.com" autoFocus autoComplete="off" spellCheck={false} />
        </Field>
      </form>
      <DialogFooter>
        <Button variant="outline" className={cancelButtonClass} onClick={close}>Cancel</Button>
        <Button className={primaryButtonClass} disabled={busy} onClick={submit}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Create Domain
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

// --- Screen ---------------------------------------------------------------------

export function DomainsScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [verifyingId, setVerifyingId] = useState(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [endpoint, setEndpoint] = useState("all");
  const [recordId, setRecordId] = useRecordParam();
  const projectId = project?.id;
  const allowed = can("pods.domains.view");
  const canWrite = can("pods.domain.write");

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

  const domains = state.items;
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return domains.filter((entry) => {
      if (status !== "all" && entry.status !== status) return false;
      if (endpoint !== "all" && entry.endpointType !== endpoint) return false;
      return !query || `${entry.domainName} ${entry.targetHostname ?? ""}`.toLowerCase().includes(query);
    });
  }, [domains, search, status, endpoint]);

  const pager = usePagination(filtered, { resetKey: `${search}|${status}|${endpoint}` });

  const stats = useMemo(() => [
    { label: "Domains", value: String(domains.length), footer: "Across this project" },
    { label: "Available", value: String(domains.filter((entry) => entry.status === "AVAILABLE").length), footer: "Serving traffic" },
    { label: "Pending", value: String(domains.filter((entry) => PENDING.has(entry.status)).length), footer: "Awaiting DNS or certificate" },
    { label: "Failed", value: String(domains.filter((entry) => entry.status === "FAILED").length), footer: "Need attention" },
  ], [domains]);

  const verify = async (domain) => {
    setVerifyingId(domain.id);
    try {
      const updated = await api(projectId, `/${domain.id}/verify`, { method: "POST" });
      toast.success(`Verified. ${domain.domainName} is now ${(DOMAIN_STATUS_MAP[updated.status]?.label ?? updated.status).toLowerCase()}.`);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setVerifyingId(null);
    }
  };

  const remove = async () => {
    const target = deleteTarget;
    setDeleting(true);
    try {
      await api(projectId, `/${target.id}`, { method: "DELETE" });
      toast.success(`Deleted "${target.domainName}".`);
      setDeleteTarget(null);
      if (recordId === target.id) setRecordId(null);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setDeleting(false);
    }
  };

  const dialogs = <>
    {canWrite ? <CreateDomainDialog
      open={creating}
      onOpenChange={setCreating}
      projectId={projectId}
      onCreated={async (created) => {
        await refresh();
        if (created?.id) setRecordId(created.id);
      }}
    /> : null}
    <ConfirmDialog
      open={!!deleteTarget}
      onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      title="Delete domain"
      confirmLabel="Delete"
      busy={deleting}
      onConfirm={remove}
    >
      Delete <span className="font-medium text-foreground">{deleteTarget?.domainName}</span>? It stops serving traffic and its mappings are removed. This can&apos;t be undone.
    </ConfirmDialog>
  </>;

  const header = <ScreenHeader
    title="Custom Domains"
    description="Serve your APIs from hostnames you own. Verify ownership over DNS, then map base paths to API stages."
    actions={canWrite && allowed ? <Button className={primaryButtonClass} onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New Domain</Button> : null}
  />;

  if (!allowed) {
    return <MainScreenWrapper>
      {header}
      <div className="rounded-xl border border-border bg-surface-subtle">
        <EmptyState icon={LockKeyhole} title="Access unavailable" description="Your current team access does not allow this screen." />
      </div>
    </MainScreenWrapper>;
  }

  const openDomain = recordId ? domains.find((entry) => entry.id === recordId) : null;
  if (openDomain) {
    return <>
      <DomainEditPage
        key={openDomain.id}
        projectId={projectId}
        domain={openDomain}
        canWrite={canWrite}
        verifying={verifyingId === openDomain.id}
        onBack={() => setRecordId(null)}
        onVerify={verify}
        onChanged={refresh}
        onDelete={setDeleteTarget}
      />
      {dialogs}
    </>;
  }

  const columns = [
    {
      key: "domain",
      header: "Domain",
      render: (entry) => <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-card text-muted-foreground">
          <Globe className="h-4 w-4" />
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-medium text-foreground">{entry.domainName}</span>
          <span className="truncate font-mono text-[11px] text-text-tertiary">CNAME → {entry.targetHostname}</span>
        </div>
      </div>,
    },
    { key: "endpoint", header: "Endpoint", render: (entry) => <Badge variant="neutral">{ENDPOINT_LABEL[entry.endpointType] ?? entry.endpointType}</Badge> },
    { key: "status", header: "Status", render: (entry) => <StatusPill status={entry.status} map={DOMAIN_STATUS_MAP} /> },
    {
      key: "certificate",
      header: "Certificate",
      render: (entry) => (entry.certificateExpiresAt
        ? <span className="inline-flex items-center gap-1.5 text-xs text-text-secondary">
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
          Expires {formatDate(entry.certificateExpiresAt)}
        </span>
        : <span className="text-xs text-text-tertiary">—</span>),
    },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (entry) => {
        const verifying = verifyingId === entry.id;
        return <ActionMenu
          label={`Actions for ${entry.domainName}`}
          items={[
            { icon: Pencil, label: "Open", onSelect: () => setRecordId(entry.id) },
            { icon: Copy, label: "Copy target", onSelect: () => copyText(entry.targetHostname, "DNS target") },
            canWrite && entry.status !== "AVAILABLE" && {
              icon: verifying ? Loader2 : RefreshCw,
              spin: verifying,
              label: verifying ? "Verifying…" : "Verify now",
              disabled: verifying,
              onSelect: () => verify(entry),
            },
            entry.status === "AVAILABLE" && !entry.domainName.startsWith("*.") && {
              icon: ExternalLink,
              label: "Visit",
              href: `https://${entry.domainName}`,
            },
            canWrite && { separator: true },
            canWrite && { icon: Trash2, label: "Delete", variant: "destructive", onSelect: () => setDeleteTarget(entry) },
          ]}
        />;
      },
    },
  ];

  return <MainScreenWrapper>
    {header}

    <StatsBar stats={stats} />

    <Toolbar>
      <div className="flex flex-wrap items-center gap-2">
        <FilterDropdown label="Status" value={status} onValueChange={setStatus} options={STATUS_FILTER_OPTIONS} height="h-9" />
        <FilterDropdown label="Endpoint type" value={endpoint} onValueChange={setEndpoint} options={ENDPOINT_FILTER_OPTIONS} height="h-9" />
      </div>
      <SearchInput value={search} onChange={setSearch} placeholder="Search domains…" />
    </Toolbar>

    {state.status === "loading" ? <LoadingArea panel label="Loading domains" /> : null}
    {state.status === "error" ? <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={Globe}
      title="Could not load domains"
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
          icon={Globe}
          title={domains.length ? "No domains match your filters" : "No custom domains yet"}
          description={domains.length
            ? "Try clearing the search or filters."
            : "Add a hostname you own to serve an API from it."}
          action={!domains.length && canWrite
            ? <Button className={primaryButtonClass} onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New Domain</Button>
            : null}
        /></div>}
      />
      <ListPagination {...pager} itemLabel="domains" />
    </div> : null}

    {dialogs}
  </MainScreenWrapper>;
}
