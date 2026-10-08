"use client";

// WAF screen (S11 Part D): web ACLs list; ACL editor (rules table with
// priority and action, statement JSON view, managed rule group picker with
// per-rule overrides, custom responses); IP sets; regex sets; associations;
// sampled requests; metrics (allowed/blocked/counted per rule).

import { useCallback, useEffect, useState } from "react";
import { LockKeyhole, Plus, Shield } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";

async function api(projectId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/waf${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

const MANAGED_GROUPS = ["PodsCommonRuleSet", "PodsSQLiRuleSet", "PodsKnownBadInputsRuleSet", "PodsAdminProtectionRuleSet"];

function RulesEditor({ projectId, acl, onChanged }) {
  // Remounted per ACL version (see `key` at the call site), so the editor
  // initializes from the saved rules once instead of syncing in an effect.
  const [rulesText, setRulesText] = useState(() => JSON.stringify(acl.rules ?? [], null, 2));
  return <div className="space-y-2">
    <div className="flex flex-wrap gap-2">
      {MANAGED_GROUPS.map((group) => <Button key={group} variant="outline" size="sm" onClick={() => {
        try {
          const rules = JSON.parse(rulesText || "[]");
          const max = rules.reduce((top, entry) => Math.max(top, entry.priority ?? 0), 0);
          rules.push({
            name: group.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
            priority: max + 10,
            action: "BLOCK",
            statement: { type: "ManagedRuleGroupStatement", name: group, excludedRules: [] },
          });
          setRulesText(JSON.stringify(rules, null, 2));
        } catch {
          toast.error("Rules JSON is invalid.");
        }
      }}>+ {group}</Button>)}
    </div>
    <Label>Rules JSON (priority order, ALLOW/BLOCK/COUNT)</Label>
    <Textarea value={rulesText} onChange={(event) => setRulesText(event.target.value)} rows={12} spellCheck={false} className="font-mono text-xs" />
    <Button size="sm" onClick={async () => {
      try {
        await api(projectId, `/web-acls/${acl.id}`, {
          method: "PATCH",
          headers: { "if-match": String(acl.version) },
          body: JSON.stringify({ rules: JSON.parse(rulesText) }),
        });
        toast.success("Web ACL updated.");
        onChanged();
      } catch (error) {
        toast.error(error.message);
      }
    }}>Save rules</Button>
  </div>;
}

function SampledRequests({ projectId, acl }) {
  const [filters, setFilters] = useState({ stage: "", rule: "" });
  const [loaded, setLoaded] = useState(null);
  const [error, setError] = useState(null);
  const query = [
    filters.stage ? `stage=${encodeURIComponent(filters.stage)}` : "",
    filters.rule ? `rule=${encodeURIComponent(filters.rule)}` : "",
    "limit=25",
  ].filter(Boolean).join("&");
  useEffect(() => {
    let alive = true;
    api(projectId, `/web-acls/${acl.id}/sampled-requests?${query}`).then(
      (data) => { if (alive) { setLoaded({ query, data }); setError(null); } },
      (err) => { if (alive) setError(err.message); },
    );
    return () => { alive = false; };
  }, [projectId, acl.id, query]);
  // Rows for the current filter (a filter change shows the loading state
  // until its own fetch resolves).
  const rows = loaded && loaded.query === query ? loaded.data : null;
  const stages = [...new Set((acl.associations ?? []).map((entry) => entry.stageName))];
  const rules = (acl.rules ?? []).map((entry) => entry.name);
  return <div className="mt-4 space-y-2">
    <Label>Sampled requests (last 3 h, ≤ 100 per rule per stage)</Label>
    <div className="flex flex-wrap gap-2">
      <select
        className="rounded-md border px-2 py-1 text-sm"
        value={filters.stage}
        onChange={(event) => setFilters({ ...filters, stage: event.target.value })}
        aria-label="Stage filter"
      >
        <option value="">All stages</option>
        {stages.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
      <select
        className="rounded-md border px-2 py-1 text-sm"
        value={filters.rule}
        onChange={(event) => setFilters({ ...filters, rule: event.target.value })}
        aria-label="Rule filter"
      >
        <option value="">All rules</option>
        {rules.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
    </div>
    {error ? <p className="text-xs text-destructive">{error}</p> : null}
    {rows === null && !error ? <p className="text-xs text-muted-foreground">Loading sampled requests…</p> : null}
    {rows && rows.items.length === 0 ? <p className="text-xs text-muted-foreground">No sampled requests yet. Blocked or counted requests appear here within seconds of gateway traffic.</p> : null}
    {rows && rows.items.length > 0 ? <ul className="space-y-1 text-sm">
      {rows.items.map((entry, index) => <li key={`${entry.t}-${index}`} className="flex flex-wrap items-center gap-2 rounded-md border p-2 font-mono text-xs">
        <span>{new Date(entry.t).toISOString()}</span>
        <Badge variant="outline">{entry.action}</Badge>
        <span>{entry.method} {entry.path}</span>
        <span className="text-muted-foreground">{entry.sourceIp}</span>
        <span className="ml-auto text-muted-foreground">{entry.rule} · {entry.stage}</span>
      </li>)}
    </ul> : null}
  </div>;
}

function AclDetail({ projectId, acl, onChanged, onClose }) {
  const [assoc, setAssoc] = useState({ apiId: "", stageName: "prod" });
  return <SectionCard title={acl.name} action={<Button variant="ghost" size="sm" onClick={onClose}>Close</Button>}>
    <div className="mb-3 flex items-center gap-2 text-sm">
      <Badge variant="outline">default {acl.defaultAction}</Badge>
      <Badge variant="outline">v{acl.version}</Badge>
    </div>
    <RulesEditor key={`${acl.id}:${acl.version}`} projectId={projectId} acl={acl} onChanged={onChanged} />
    <div className="mt-4 space-y-2">
      <Label>Stage associations (one ACL per stage)</Label>
      <ul className="space-y-1 text-sm">
        {(acl.associations ?? []).map((entry) => <li key={entry.id} className="font-mono text-xs">{entry.apiId} · {entry.stageName}</li>)}
      </ul>
      <div className="flex items-end gap-2">
        <div><Label>API id</Label><Input value={assoc.apiId} onChange={(event) => setAssoc({ ...assoc, apiId: event.target.value })} /></div>
        <div><Label>Stage</Label><Input value={assoc.stageName} onChange={(event) => setAssoc({ ...assoc, stageName: event.target.value })} /></div>
        <Button size="sm" onClick={async () => {
          try {
            await api(projectId, `/web-acls/${acl.id}/associations`, { method: "POST", body: JSON.stringify(assoc) });
            toast.success("Associated.");
            onChanged();
          } catch (error) {
            toast.error(error.message);
          }
        }}>Associate</Button>
      </div>
      <p className="text-xs text-muted-foreground">Sampled requests (last 3 h, ≤ 100 per rule per stage) and per-rule metrics are served from the gateway KV store.</p>
      <SampledRequests projectId={projectId} acl={acl} />
    </div>
  </SectionCard>;
}

function SetsManager({ projectId, kind }) {
  const [items, setItems] = useState(null);
  const [name, setName] = useState("");
  const [entries, setEntries] = useState("");
  const path = kind === "ip" ? "/ip-sets" : "/regex-sets";
  const load = useCallback(async () => {
    try {
      setItems(await api(projectId, path));
    } catch (error) {
      toast.error(error.message);
    }
  }, [projectId, path]);
  useEffect(() => {
    let alive = true;
    api(projectId, path).then(
      (data) => { if (alive) setItems(data); },
      (error) => { if (alive) toast.error(error.message); },
    );
    return () => { alive = false; };
  }, [projectId, path]);
  return <div className="space-y-2">
    <ul className="space-y-1 text-sm">
      {(items?.items ?? []).map((entry) => <li key={entry.id} className="rounded-md border p-2">
        <span className="font-medium">{entry.name}</span>
        <span className="ml-2 font-mono text-xs text-muted-foreground">{(entry.addresses ?? entry.patterns ?? []).join(", ")}</span>
      </li>)}
    </ul>
    <div className="flex flex-wrap items-end gap-2">
      <div><Label>Name</Label><Input value={name} onChange={(event) => setName(event.target.value)} /></div>
      <div className="min-w-64 flex-1"><Label>{kind === "ip" ? "CIDRs (comma separated)" : "Patterns (comma separated)"}</Label><Input value={entries} onChange={(event) => setEntries(event.target.value)} placeholder={kind === "ip" ? "203.0.113.0/24" : "^/admin"} /></div>
      <Button size="sm" onClick={async () => {
        try {
          const list = entries.split(",").map((part) => part.trim()).filter(Boolean);
          await api(projectId, path, {
            method: "POST",
            body: JSON.stringify(kind === "ip"
              ? { name, ipVersion: "IPV4", addresses: list }
              : { name, patterns: list }),
          });
          toast.success("Set created.");
          setName("");
          setEntries("");
          await load();
        } catch (error) {
          toast.error(error.message);
        }
      }}>Create</Button>
    </div>
  </div>;
}

export function WafScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("main");
  const [selected, setSelected] = useState(null);
  const projectId = project?.id;

  const load = useCallback(async () => {
    if (!projectId) return;
    setState({ status: "loading", items: [], error: null });
    try {
      const data = await api(projectId, "/web-acls");
      setState({ status: "ready", items: data.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [projectId]);
  useEffect(() => {
    if (!projectId) return undefined;
    let alive = true;
    api(projectId, "/web-acls").then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [projectId]);
  // Refreshes the list and the open detail (a save bumps `version`, so the
  // detail must reload or the next save conflicts).
  const refreshDetail = useCallback(async () => {
    await load();
    if (selected) {
      try {
        setSelected(await api(projectId, `/web-acls/${selected.id}`));
      } catch {
        setSelected(null);
      }
    }
  }, [load, projectId, selected]);

  if (!can("pods.domains.view")) return <EmptyState icon={LockKeyhole} title="Access unavailable" description="Your current team access does not allow this screen." />;
  if (state.status === "loading") return <LogoLoading />;
  if (state.status === "error") return <EmptyState title="Could not load web ACLs" description={state.error} />;

  return <div className="space-y-4">
    <ScreenHeader
      title="Web application firewall"
      description="IP sets, regex sets and web ACLs (REST APIs)."
      action={<Button size="sm" onClick={() => setCreating(true)}><Plus className="size-4" />New web ACL</Button>}
    />
    <div className="flex gap-2">
      <Button variant="outline" size="sm" asChild><a href="../domains">Custom domains</a></Button>
    </div>
    {state.items.length === 0 ? <EmptyState icon={Shield} title="No web ACLs" description="Create one, add rules, then associate it with an API stage." /> : <SectionCard title="Web ACLs">
      <ul className="space-y-2">
        {state.items.map((entry) => <li key={entry.id}>
          <button type="button" className="flex w-full items-center gap-3 rounded-md border p-3 text-left text-sm hover:bg-muted/50" onClick={async () => {
            try {
              setSelected(await api(projectId, `/web-acls/${entry.id}`));
            } catch (error) {
              toast.error(error.message);
            }
          }}>
            <span className="font-medium">{entry.name}</span>
            <Badge variant="outline">default {entry.defaultAction}</Badge>
            <span className="ml-auto text-xs text-muted-foreground">{(entry.rules ?? []).length} rules</span>
          </button>
        </li>)}
      </ul>
    </SectionCard>}
    {selected ? <AclDetail projectId={projectId} acl={selected} onChanged={refreshDetail} onClose={() => setSelected(null)} /> : null}
    <SectionCard title="IP sets"><SetsManager projectId={projectId} kind="ip" /></SectionCard>
    <SectionCard title="Regex sets"><SetsManager projectId={projectId} kind="regex" /></SectionCard>
    <Dialog open={creating} onOpenChange={setCreating}>
      <DialogContent>
        <DialogHeader><DialogTitle>New web ACL</DialogTitle><DialogDescription>Default action applies when no rule terminates.</DialogDescription></DialogHeader>
        <Label>Name</Label>
        <Input value={name} onChange={(event) => setName(event.target.value)} />
        <DialogFooter>
          <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
          <Button onClick={async () => {
            try {
              await api(projectId, "/web-acls", { method: "POST", body: JSON.stringify({ name, defaultAction: "ALLOW", rules: [] }) });
              toast.success("Web ACL created.");
              setCreating(false);
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
