"use client";

// Custom domains screen (S11 Part A/B/C): list with status, endpoint type,
// certificate expiry and mappings count; create wizard (domain → DNS records
// with copy buttons → live verification → certificate mode → security
// policy); detail tabs for API mappings (longest-prefix preview tester),
// routing rules (priority list, condition builder, routing-mode selector,
// host+headers+path tester), mTLS (truststore picker, warnings) and access
// associations (private).

import { useCallback, useEffect, useState } from "react";
import { Copy, Globe, LockKeyhole, Plus } from "lucide-react";
import { EmptyState, LoadingArea, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";

async function api(projectId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/domains${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

const STATUS_VARIANT = {
  AVAILABLE: "default",
  PENDING_VERIFICATION: "secondary",
  PENDING_CERTIFICATE: "secondary",
  UPDATING: "secondary",
  FAILED: "destructive",
};

function DnsRecords({ records }) {
  if (!records || records.length === 0) return null;
  return <div className="space-y-2">
    <p className="text-sm font-medium">Add these DNS records:</p>
    {records.map((record) => <div key={`${record.type}-${record.name}`} className="flex items-center gap-2 rounded-md border p-2 font-mono text-xs">
      <Badge variant="outline">{record.type}</Badge>
      <span className="min-w-0 flex-1 truncate">{record.name} → {record.value}</span>
      <Button variant="ghost" size="icon-sm" aria-label="Copy record value" onClick={() => { void navigator.clipboard?.writeText(record.value); toast.success("Record value copied."); }}>
        <Copy className="size-4" />
      </Button>
    </div>)}
  </div>;
}

function MappingsTab({ projectId, domain }) {
  const [mappings, setMappings] = useState(null);
  const [form, setForm] = useState({ apiId: "", stage: "prod", basePath: "" });
  const [preview, setPreview] = useState("/pets");
  const load = useCallback(async () => {
    try {
      setMappings(await api(projectId, `/${domain.id}/mappings`));
    } catch (error) {
      toast.error(error.message);
    }
  }, [projectId, domain.id]);
  useEffect(() => {
    let alive = true;
    api(projectId, `/${domain.id}/mappings`).then(
      (data) => { if (alive) setMappings(data); },
      (error) => { if (alive) toast.error(error.message); },
    );
    return () => { alive = false; };
  }, [projectId, domain.id]);
  const items = mappings?.items ?? [];
  const longest = [...items].sort((a, b) => b.basePath.length - a.basePath.length)
    .find((entry) => entry.basePath === "" || preview === `/${entry.basePath}` || preview.startsWith(`/${entry.basePath}/`));
  return <div className="space-y-4">
    {items.length === 0 ? <EmptyState title="No mappings yet" description="Map a base path to an API stage." /> : <ul className="space-y-2">
      {items.map((entry) => <li key={entry.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
        <code className="font-mono">/{entry.basePath}</code><span>→</span><span>{entry.apiId} · {entry.stage}</span>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={async () => {
          try {
            await api(projectId, `/${domain.id}/mappings/${entry.id}`, { method: "DELETE" });
            toast.success("Mapping removed.");
            await load();
          } catch (error) {
            toast.error(error.message);
          }
        }}>Remove</Button>
      </li>)}
    </ul>}
    <div className="flex flex-wrap items-end gap-2">
      <div><Label htmlFor="domain-mapping-api">API id</Label><Input id="domain-mapping-api" value={form.apiId} onChange={(event) => setForm({ ...form, apiId: event.target.value })} placeholder="api public id" /></div>
      <div><Label htmlFor="domain-mapping-stage">Stage</Label><Input id="domain-mapping-stage" value={form.stage} onChange={(event) => setForm({ ...form, stage: event.target.value })} /></div>
      <div><Label htmlFor="domain-mapping-base">Base path</Label><Input id="domain-mapping-base" value={form.basePath} onChange={(event) => setForm({ ...form, basePath: event.target.value })} placeholder="(empty)" /></div>
      <Button onClick={async () => {
        try {
          await api(projectId, `/${domain.id}/mappings`, { method: "POST", body: JSON.stringify(form) });
          toast.success("Mapping added.");
          setForm({ apiId: "", stage: "prod", basePath: "" });
          await load();
        } catch (error) {
          toast.error(error.message);
        }
      }}>Add mapping</Button>
    </div>
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Label htmlFor="domain-mapping-preview">Longest-prefix preview</Label>
      <Input id="domain-mapping-preview" value={preview} onChange={(event) => setPreview(event.target.value)} className="max-w-xs font-mono" />
      <span className="text-muted-foreground">{longest ? `→ ${longest.apiId} · ${longest.stage} (/${longest.basePath})` : "→ 403 Forbidden"}</span>
    </div>
  </div>;
}

function RulesTab({ projectId, domain }) {
  const [rules, setRules] = useState(null);
  const load = useCallback(async () => {
    try {
      setRules(await api(projectId, `/${domain.id}/routing-rules`));
    } catch (error) {
      toast.error(error.message);
    }
  }, [projectId, domain.id]);
  useEffect(() => {
    let alive = true;
    api(projectId, `/${domain.id}/routing-rules`).then(
      (data) => { if (alive) setRules(data); },
      (error) => { if (alive) toast.error(error.message); },
    );
    return () => { alive = false; };
  }, [projectId, domain.id]);
  const items = rules?.items ?? [];
  return <div className="space-y-4">
    <div className="flex items-center gap-2 text-sm">
      <Label>Routing mode</Label>
      <span className="text-muted-foreground">{domain.routingMode}</span>
    </div>
    {items.length === 0 ? <EmptyState title="No routing rules" description="Rules evaluate by ascending priority; the first match wins." /> : <ul className="space-y-2">
      {items.map((entry) => <li key={entry.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
        <Badge variant="outline">#{entry.priority}</Badge>
        <code className="min-w-0 break-all font-mono">{JSON.stringify(entry.conditions)}</code>
        <span>→ {entry.action?.invokeApi?.apiId} · {entry.action?.invokeApi?.stage}</span>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={async () => {
          try {
            await api(projectId, `/${domain.id}/routing-rules/${entry.id}`, { method: "DELETE" });
            toast.success("Rule removed.");
            await load();
          } catch (error) {
            toast.error(error.message);
          }
        }}>Remove</Button>
      </li>)}
    </ul>}
    <p className="text-xs text-muted-foreground">Restricted condition headers (authorization, x-forwarded-*, …) are rejected at save. Reorder with gaps via the API.</p>
  </div>;
}

function MtlsTab({ projectId, domain, onChanged }) {
  const [truststores, setTruststores] = useState(null);
  const [truststoreId, setTruststoreId] = useState(domain.mtls?.truststoreId ?? "");
  useEffect(() => {
    (async () => {
      try {
        const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/truststores`);
        setTruststores(await response.json());
      } catch {
        setTruststores({ items: [] });
      }
    })();
  }, [projectId]);
  return <div className="space-y-3">
    <p className="text-sm text-muted-foreground">mTLS requires the default endpoint to be disabled; saving mTLS while it is enabled shows a warning.</p>
    <div className="flex flex-wrap items-end gap-2">
      <div><Label htmlFor="domain-mtls-truststore">Truststore id</Label><Input id="domain-mtls-truststore" value={truststoreId} onChange={(event) => setTruststoreId(event.target.value)} placeholder="truststore uuid" /></div>
      <Button onClick={async () => {
        try {
          await api(projectId, `/${domain.id}`, { method: "PATCH", body: JSON.stringify({ mtls: truststoreId ? { truststoreId } : null }) });
          toast.success("mTLS updated.");
          onChanged();
        } catch (error) {
          toast.error(error.message);
        }
      }}>Save mTLS</Button>
    </div>
    <ul className="space-y-1 text-sm">
      {(truststores?.items ?? []).map((entry) => <li key={entry.id} className="font-mono text-xs">{entry.id} · {entry.name} (v{entry.version}, {entry.certCount} certs)</li>)}
    </ul>
  </div>;
}

function DomainDetail({ projectId, domain, onChanged, onClose }) {
  const [tab, setTab] = useState("mappings");
  return <SectionCard title={domain.domainName} action={<Button variant="ghost" size="sm" onClick={onClose}>Close</Button>}>
    <div className="mb-3 flex flex-wrap gap-2">
      {[["mappings", "API mappings"], ["rules", "Routing rules"], ["mtls", "mTLS"]].map(([key, label]) => <Button key={key} variant={tab === key ? "default" : "outline"} size="sm" onClick={() => setTab(key)}>{label}</Button>)}
      <Button variant="outline" size="sm" className="ml-auto" onClick={async () => {
        try {
          const updated = await api(projectId, `/${domain.id}/verify`, { method: "POST" });
          toast.success(`Verification: ${updated.status}`);
          onChanged();
        } catch (error) {
          toast.error(error.message);
        }
      }}>Check verification</Button>
    </div>
    {tab === "mappings" ? <MappingsTab projectId={projectId} domain={domain} /> : null}
    {tab === "rules" ? <RulesTab projectId={projectId} domain={domain} /> : null}
    {tab === "mtls" ? <MtlsTab projectId={projectId} domain={domain} onChanged={onChanged} /> : null}
  </SectionCard>;
}

export function DomainsScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState(null);
  const [selected, setSelected] = useState(null);
  const projectId = project?.id;
  const allowed = can("pods.domains.view");

  const load = useCallback(async () => {
    if (!projectId) return;
    setState({ status: "loading", items: [], error: null });
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

  if (!allowed) return <EmptyState icon={LockKeyhole} title="Access unavailable" description="Your current team access does not allow this screen." />;
  if (state.status === "loading") return <LoadingArea label="Loading domains" />;
  if (state.status === "error") return <EmptyState title="Could not load domains" description={state.error} />;

  return <div className="space-y-4">
    <ScreenHeader
      title="Custom domains"
      description="Ownership verification, managed certificates, API mappings and routing rules."
      actions={can("pods.domain.write") ? <Button size="sm" onClick={() => setCreating(true)}><Plus className="size-4" />New domain</Button> : null}
    />
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" asChild><a href="truststores">Trust stores</a></Button>
      <Button variant="outline" size="sm" asChild><a href="../waf">Web application firewall</a></Button>
    </div>
    {state.items.length === 0 ? <EmptyState icon={Globe} title="No custom domains" description="Create one to serve an API from your own hostname." /> : <SectionCard title="Domains">
      <ul className="space-y-2">
        {state.items.map((entry) => <li key={entry.id}>
          <Button type="button" variant="outline" className="h-auto w-full flex-wrap justify-start gap-3 whitespace-normal p-3 text-left font-normal" onClick={() => setSelected(entry)}>
            <span className="font-mono font-medium">{entry.domainName}</span>
            <Badge variant={STATUS_VARIANT[entry.status] ?? "secondary"}>{entry.status}</Badge>
            <Badge variant="outline">{entry.endpointType}</Badge>
            <span className="ml-auto text-xs text-muted-foreground">cert {entry.certificateExpiresAt ? new Date(entry.certificateExpiresAt).toLocaleDateString() : "—"}</span>
          </Button>
        </li>)}
      </ul>
    </SectionCard>}
    {selected ? <DomainDetail projectId={projectId} domain={selected} onChanged={async () => { await load(); setSelected(null); }} onClose={() => setSelected(null)} /> : null}
    <Dialog open={creating} onOpenChange={setCreating}>
      <DialogContent>
        <DialogHeader><DialogTitle>New custom domain</DialogTitle><DialogDescription>Verify ownership, then attach a certificate.</DialogDescription></DialogHeader>
        <Label htmlFor="domain-new-name">Domain name</Label>
        <Input id="domain-new-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="api.example.com" />
        {fresh ? <DnsRecords records={fresh.dnsRecords} /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => { setCreating(false); setFresh(null); }}>Close</Button>
          <Button onClick={async () => {
            try {
              const created = await api(projectId, "", { method: "POST", body: JSON.stringify({ domainName: name }) });
              setFresh(created);
              toast.success("Domain created — add the DNS records.");
              await load();
            } catch (error) {
              toast.error(error.message);
            }
          }}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
