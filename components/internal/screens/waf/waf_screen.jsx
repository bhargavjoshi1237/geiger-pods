"use client";

// Web Application Firewall: web ACLs (list + in-place editor with rules,
// managed rule sets, stage associations and sampled requests), IP sets and
// regex sets — the three record types split by tabs like Team & Members.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, Copy, Link2, ListOrdered, Loader2, LockKeyhole, Network, Pencil, Plus, Regex, Shield, ShieldCheck,
} from "lucide-react";
import {
  DataTable, EmptyState, Field, LoadingArea, ScreenHeader, SearchInput, SectionCard, SettingsList, StatsBar, StatusPill, Toolbar,
} from "@/components/internal/shared/screen_kit";
import { MainScreenWrapper } from "@/components/internal/shared/screen_wrappers";
import { ListPagination, usePagination } from "@/components/internal/shared/pagination";
import { EditorHeader, EditorShell } from "@/components/internal/shared/editor_shell";
import FilterDropdown from "@/components/internal/screens/overview/filter_dropdown";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Textarea } from "@geiger/ui/textarea";
import { cn } from "@geiger/ui/lib/utils";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { useRecordParam } from "@/lib/hooks/use-record-param";

async function api(projectId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/waf${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

const MANAGED_GROUPS = [
  { name: "PodsCommonRuleSet", desc: "Size limits, path traversal, LFI/RFI, bad user agents and metadata-SSRF strings." },
  { name: "PodsSQLiRuleSet", desc: "SQL injection across path, query string, body and JSON bodies." },
  { name: "PodsKnownBadInputsRuleSet", desc: "Log4j JNDI, Java deserialization, localhost host headers and XSS." },
  { name: "PodsAdminProtectionRuleSet", desc: "Blocks outside access to /admin paths." },
];

const DEFAULT_ACTION_MAP = {
  ALLOW: { label: "Default allow", variant: "success", dotClass: "bg-emerald-400" },
  BLOCK: { label: "Default block", variant: "danger", dotClass: "bg-red-400" },
};

const RULE_ACTION_MAP = {
  ALLOW: { label: "Allow", variant: "success", dotClass: "bg-emerald-400" },
  BLOCK: { label: "Block", variant: "danger", dotClass: "bg-red-400" },
  COUNT: { label: "Count", variant: "info", dotClass: "bg-sky-400" },
};

const DEFAULT_ACTION_FILTER = [
  { value: "all", label: "All Default Actions" },
  { value: "ALLOW", label: "Allow" },
  { value: "BLOCK", label: "Block" },
];

const TABS = [
  { key: "acls", label: "Web ACLs" },
  { key: "ip", label: "IP Sets" },
  { key: "regex", label: "Regex Sets" },
];

const SET_KINDS = {
  ip: { path: "/ip-sets", singular: "IP Set", plural: "IP sets", icon: Network, entriesLabel: "CIDRs", placeholder: "203.0.113.0/24" },
  regex: { path: "/regex-sets", singular: "Regex Set", plural: "regex sets", icon: Regex, entriesLabel: "Patterns", placeholder: "^/admin" },
};

const CANCEL_CLASS = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";
const PRIMARY_CLASS = "bg-primary text-primary-foreground hover:bg-primary/90";
const ICON_TILE = "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-card text-muted-foreground";

const formatDate = (value) => (value ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");

function copyId(id) {
  navigator.clipboard?.writeText(id).then(
    () => toast.success("Copied."),
    () => toast.error("Copy failed."),
  );
}

function useCollection(projectId, path) {
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await api(projectId, path);
      setState({ status: "ready", items: data.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [projectId, path]);
  const retry = useCallback(() => {
    setState({ status: "loading", items: [], error: null });
    return refresh();
  }, [refresh]);
  useEffect(() => {
    if (!projectId) return undefined;
    let alive = true;
    api(projectId, path).then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [projectId, path]);
  return { ...state, refresh, retry };
}

function ErrorPanel({ icon, title, error, onRetry }) {
  return <div className="rounded-xl border border-border bg-surface-subtle">
    <EmptyState icon={icon} title={title} description={error} action={<Button variant="outline" onClick={onRetry}>Retry</Button>} />
  </div>;
}

// --- Create dialogs -----------------------------------------------------------

function CreateAclDialog({ projectId, open, onOpenChange, onCreated }) {
  const [name, setName] = useState("main");
  const [busy, setBusy] = useState(false);

  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setName("main");
  }

  const submit = async (event) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Give the web ACL a name first.");
      return;
    }
    setBusy(true);
    try {
      const created = await api(projectId, "/web-acls", { method: "POST", body: JSON.stringify({ name: trimmed, defaultAction: "ALLOW", rules: [] }) });
      toast.success(`"${trimmed}" created.`);
      onOpenChange(false);
      await onCreated(created);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md bg-background">
      <DialogHeader>
        <DialogTitle>New Web ACL</DialogTitle>
        <DialogDescription>Starts empty with a default action of Allow, which applies when no rule terminates.</DialogDescription>
      </DialogHeader>
      <form className="grid gap-4" onSubmit={submit}>
        <Field label="Name" htmlFor="waf-acl-name">
          <Input id="waf-acl-name" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" className={CANCEL_CLASS} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" className={PRIMARY_CLASS} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Create Web ACL
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

function CreateSetDialog({ projectId, kind, onOpenChange, onCreated }) {
  const meta = SET_KINDS[kind];
  const [name, setName] = useState("");
  const [entries, setEntries] = useState("");
  const [busy, setBusy] = useState(false);

  const [prevKind, setPrevKind] = useState(kind);
  if (kind !== prevKind) {
    setPrevKind(kind);
    setName("");
    setEntries("");
  }

  const submit = async (event) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Give the set a name first.");
      return;
    }
    setBusy(true);
    try {
      const list = entries.split(/[,\n]/).map((part) => part.trim()).filter(Boolean);
      await api(projectId, meta.path, {
        method: "POST",
        body: JSON.stringify(kind === "ip"
          ? { name: trimmed, ipVersion: "IPV4", addresses: list }
          : { name: trimmed, patterns: list }),
      });
      toast.success(`"${trimmed}" created.`);
      onOpenChange(false);
      await onCreated();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open={!!meta} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md bg-background">
      <DialogHeader>
        <DialogTitle>New {meta?.singular}</DialogTitle>
        <DialogDescription>
          {kind === "ip" ? "IPv4 CIDR ranges that rules can match by set ID." : "RE2-safe patterns that rules can match by set ID."}
        </DialogDescription>
      </DialogHeader>
      <form className="grid gap-4" onSubmit={submit}>
        <Field label="Name" htmlFor="waf-set-name">
          <Input id="waf-set-name" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </Field>
        <Field label={meta?.entriesLabel} htmlFor="waf-set-entries" hint="One per line, or comma separated.">
          <Textarea id="waf-set-entries" rows={5} value={entries} onChange={(event) => setEntries(event.target.value)} placeholder={meta?.placeholder} spellCheck={false} className="font-mono text-xs" />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" className={CANCEL_CLASS} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" className={PRIMARY_CLASS} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Create {meta?.singular}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

// --- Web ACL editor sections ---------------------------------------------------

function statementSummary(statement, setNames) {
  if (!statement) return "—";
  switch (statement.type) {
    case "ManagedRuleGroupStatement": {
      const excluded = statement.excludedRules?.length ?? 0;
      return `${statement.name}${excluded ? ` (${excluded} excluded)` : ""}`;
    }
    case "IPSetReferenceStatement": return `IP set ${setNames.get(statement.ipSetId) ?? statement.ipSetId}`;
    case "RegexPatternSetReferenceStatement": return `Regex set ${setNames.get(statement.regexSetId) ?? statement.regexSetId}`;
    default: return statement.type ?? "—";
  }
}

function RulesSection({ draft, setDraft, rules, setNames }) {
  const columns = [
    { key: "priority", header: "Priority", render: (rule) => <span className="text-sm tabular-nums text-text-secondary">{rule.priority}</span> },
    { key: "name", header: "Rule", render: (rule) => <span className="font-medium text-foreground">{rule.name}</span> },
    {
      key: "action",
      header: "Action",
      render: (rule) => <div className="flex flex-wrap items-center gap-1.5">
        <StatusPill status={rule.action} map={RULE_ACTION_MAP} />
        {rule.overrideAction === "COUNT" ? <Badge variant="outline">override count</Badge> : null}
      </div>,
    },
    { key: "statement", header: "Statement", render: (rule) => <span className="font-mono text-xs text-text-secondary">{statementSummary(rule.statement, setNames)}</span> },
  ];
  const sorted = rules ? [...rules].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)) : [];

  return <div className="space-y-6">
    <SectionCard title="Rules" bodyPadding={false}>
      {rules === null
        ? <EmptyState icon={ListOrdered} title="Rules JSON is invalid" description="Fix the JSON below to see the rule table." />
        : <DataTable
          className="rounded-none border-0"
          columns={columns}
          data={sorted}
          getRowKey={(rule, index) => `${rule.priority}-${rule.name}-${index}`}
          empty={<EmptyState icon={ListOrdered} title="No rules yet" description="Add a managed rule set or write rules in the JSON below." />}
        />}
    </SectionCard>
    <SectionCard title="Rules JSON" description="Priority order; each rule's action is ALLOW, BLOCK or COUNT. Saved with Save Changes.">
      <Textarea
        aria-label="Rules JSON"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={14}
        spellCheck={false}
        className="font-mono text-xs"
      />
    </SectionCard>
  </div>;
}

function ManagedSection({ rules, onAdd }) {
  const added = new Set((rules ?? [])
    .filter((rule) => rule.statement?.type === "ManagedRuleGroupStatement")
    .map((rule) => rule.statement.name));
  return <SectionCard description="Adding a rule set appends a BLOCK rule after your last priority. Saved with Save Changes." title="Rule sets">
    <SettingsList>
      {MANAGED_GROUPS.map((group) => <div key={group.name} className="flex items-center justify-between gap-4 py-3.5 first:pt-0 last:pb-0">
        <div className="flex min-w-0 items-center gap-3">
          <div className={ICON_TILE}><ShieldCheck className="h-4 w-4" /></div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{group.name}</p>
            <p className="text-xs text-text-secondary">{group.desc}</p>
          </div>
        </div>
        {added.has(group.name)
          ? <Badge variant="neutral">Added</Badge>
          : <Button variant="outline" size="sm" onClick={() => onAdd(group.name)}><Plus className="h-4 w-4" /> Add</Button>}
      </div>)}
    </SettingsList>
  </SectionCard>;
}

function AssociationsSection({ projectId, acl, onChanged }) {
  const [assoc, setAssoc] = useState({ apiId: "", stageName: "prod" });
  const [busy, setBusy] = useState(false);
  const associate = async () => {
    setBusy(true);
    try {
      await api(projectId, `/web-acls/${acl.id}/associations`, { method: "POST", body: JSON.stringify(assoc) });
      toast.success("Associated.");
      await onChanged();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };
  const columns = [
    { key: "api", header: "API ID", render: (entry) => <span className="font-mono text-xs text-foreground">{entry.apiId}</span> },
    { key: "stage", header: "Stage", render: (entry) => <Badge variant="neutral">{entry.stageName}</Badge> },
    { key: "created", header: "Associated", render: (entry) => <span className="text-sm tabular-nums text-text-secondary">{formatDate(entry.createdAt)}</span> },
  ];
  return <div className="space-y-6">
    <SectionCard title="Associated stages" bodyPadding={false}>
      <DataTable
        className="rounded-none border-0"
        columns={columns}
        data={acl.associations ?? []}
        getRowKey={(entry) => entry.id}
        empty={<EmptyState icon={Link2} title="Not associated yet" description="Associate an API stage below to start filtering its traffic." />}
      />
    </SectionCard>
    <SectionCard
      title="Associate a stage"
      description="A stage can have only one web ACL."
      action={<Button className={PRIMARY_CLASS} disabled={busy} onClick={associate}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />} Associate
      </Button>}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="API ID" htmlFor="waf-assoc-api">
          <Input id="waf-assoc-api" value={assoc.apiId} onChange={(event) => setAssoc({ ...assoc, apiId: event.target.value })} className="font-mono text-xs" />
        </Field>
        <Field label="Stage" htmlFor="waf-assoc-stage">
          <Input id="waf-assoc-stage" value={assoc.stageName} onChange={(event) => setAssoc({ ...assoc, stageName: event.target.value })} />
        </Field>
      </div>
    </SectionCard>
  </div>;
}

function SampledRequestsSection({ projectId, acl }) {
  const [stage, setStage] = useState("all");
  const [rule, setRule] = useState("all");
  const [loaded, setLoaded] = useState(null);
  const [error, setError] = useState(null);
  const query = [
    stage !== "all" ? `stage=${encodeURIComponent(stage)}` : "",
    rule !== "all" ? `rule=${encodeURIComponent(rule)}` : "",
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
  const rows = loaded && loaded.query === query ? loaded.data.items ?? [] : null;
  const stageOptions = [
    { value: "all", label: "All Stages" },
    ...[...new Set((acl.associations ?? []).map((entry) => entry.stageName))].map((name) => ({ value: name, label: name })),
  ];
  const ruleOptions = [
    { value: "all", label: "All Rules" },
    ...(acl.rules ?? []).map((entry) => ({ value: entry.name, label: entry.name })),
  ];
  const columns = [
    { key: "time", header: "Time", render: (entry) => <span className="font-mono text-xs tabular-nums text-text-secondary">{new Date(entry.t).toISOString()}</span> },
    { key: "action", header: "Action", render: (entry) => <StatusPill status={entry.action} map={RULE_ACTION_MAP} /> },
    { key: "request", header: "Request", render: (entry) => <span className="font-mono text-xs text-foreground">{entry.method} {entry.path}</span> },
    { key: "source", header: "Source IP", render: (entry) => <span className="font-mono text-xs text-text-secondary">{entry.sourceIp}</span> },
    { key: "rule", header: "Rule", render: (entry) => <span className="text-sm text-text-secondary">{entry.rule}</span> },
    { key: "stage", header: "Stage", render: (entry) => <Badge variant="neutral">{entry.stage}</Badge> },
  ];
  return <div className="space-y-5">
    <Toolbar>
      <div className="flex flex-wrap items-center gap-2">
        <FilterDropdown label="Stage" value={stage} onValueChange={setStage} options={stageOptions} height="h-9" />
        <FilterDropdown label="Rule" value={rule} onValueChange={setRule} options={ruleOptions} height="h-9" />
      </div>
    </Toolbar>
    {error ? <div className="rounded-xl border border-border bg-surface-subtle">
      <EmptyState icon={Activity} title="Sampled requests unavailable" description={error} />
    </div> : null}
    {rows === null && !error ? <LoadingArea panel label="Loading sampled requests" /> : null}
    {rows !== null && !error ? <DataTable
      columns={columns}
      data={rows}
      getRowKey={(entry, index) => `${entry.t}-${index}`}
      empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
        icon={Activity}
        title="No sampled requests yet"
        description="Blocked or counted requests appear here within seconds of gateway traffic."
      /></div>}
    /> : null}
  </div>;
}

const ACL_SECTIONS = [
  {
    group: null,
    items: [
      { key: "rules", label: "Rules", icon: ListOrdered, desc: "Evaluated in priority order; the first ALLOW or BLOCK wins, otherwise the default action applies." },
      { key: "managed", label: "Managed Rule Sets", icon: ShieldCheck, desc: "Pods-maintained rule groups you can add to this ACL." },
    ],
  },
  {
    group: "Traffic",
    items: [
      { key: "associations", label: "Associations", icon: Link2, desc: "API stages this web ACL protects." },
      { key: "sampled", label: "Sampled Requests", icon: Activity, desc: "Blocked and counted requests from the last 3 hours, up to 100 per rule per stage." },
    ],
  },
];

const rulesText = (acl) => JSON.stringify(acl.rules ?? [], null, 2);

function parseRules(text) {
  try {
    const parsed = JSON.parse(text || "[]");
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function AclEditPage({ projectId, aclId, setNames, onBack, onChanged }) {
  const [state, setState] = useState({ status: "loading", acl: null, error: null });
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  // A save bumps `version`, so the editor reloads the ACL or the next save
  // conflicts. Only a load after save resets the draft; an association
  // change keeps unsaved rule edits.
  const load = useCallback(async ({ resetDraft = false } = {}) => {
    try {
      const acl = await api(projectId, `/web-acls/${aclId}`);
      setState({ status: "ready", acl, error: null });
      if (resetDraft) setDraft(rulesText(acl));
    } catch (error) {
      setState({ status: "error", acl: null, error: error.message });
    }
  }, [projectId, aclId]);

  useEffect(() => {
    let alive = true;
    api(projectId, `/web-acls/${aclId}`).then(
      (acl) => { if (alive) { setState({ status: "ready", acl, error: null }); setDraft(rulesText(acl)); } },
      (error) => { if (alive) setState({ status: "error", acl: null, error: error.message }); },
    );
    return () => { alive = false; };
  }, [projectId, aclId]);

  const rules = useMemo(() => parseRules(draft), [draft]);
  const back = { label: "All Web ACLs", onClick: onBack };

  if (state.status === "loading") return <LoadingArea label="Loading web ACL" />;
  if (state.status === "error") {
    return <MainScreenWrapper>
      <EditorHeader back={back} title="Web ACL unavailable" />
      <ErrorPanel icon={Shield} title="Web ACL unavailable" error={state.error} onRetry={() => { setState({ status: "loading", acl: null, error: null }); load({ resetDraft: true }); }} />
    </MainScreenWrapper>;
  }

  const acl = state.acl;
  const dirty = draft !== rulesText(acl);

  const save = async () => {
    let parsed;
    try {
      parsed = JSON.parse(draft);
    } catch {
      toast.error("Rules JSON is invalid.");
      return;
    }
    setSaving(true);
    try {
      await api(projectId, `/web-acls/${acl.id}`, {
        method: "PATCH",
        headers: { "if-match": String(acl.version) },
        body: JSON.stringify({ rules: parsed }),
      });
      toast.success("Web ACL updated.");
      await Promise.all([load({ resetDraft: true }), onChanged()]);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const addManaged = (group) => {
    const current = parseRules(draft);
    if (!current) {
      toast.error("Rules JSON is invalid.");
      return;
    }
    const max = current.reduce((top, entry) => Math.max(top, entry.priority ?? 0), 0);
    setDraft(JSON.stringify([...current, {
      name: group.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      priority: max + 10,
      action: "BLOCK",
      statement: { type: "ManagedRuleGroupStatement", name: group, excludedRules: [] },
    }], null, 2));
    toast.success(`Added ${group}. Save to apply it.`);
  };

  const refreshAcl = () => Promise.all([load(), onChanged()]);

  return <EditorShell
    back={back}
    title={acl.name}
    status={acl.defaultAction}
    statusMap={DEFAULT_ACTION_MAP}
    badges={<>
      <Badge variant="outline">v{acl.version}</Badge>
      <span className="font-mono text-xs text-text-secondary">{acl.id}</span>
    </>}
    actions={<>
      {dirty ? <span className="text-sm text-text-secondary">Unsaved changes</span> : null}
      <Button className={PRIMARY_CLASS} disabled={saving} onClick={save}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{saving ? "Saving…" : "Save Changes"}
      </Button>
    </>}
    nav={ACL_SECTIONS}
    defaultSection="rules"
  >
    {({ active }) => {
      switch (active) {
        case "managed": return <ManagedSection rules={rules} onAdd={addManaged} />;
        case "associations": return <AssociationsSection projectId={projectId} acl={acl} onChanged={refreshAcl} />;
        case "sampled": return <SampledRequestsSection projectId={projectId} acl={acl} />;
        default: return <RulesSection draft={draft} setDraft={setDraft} rules={rules} setNames={setNames} />;
      }
    }}
  </EditorShell>;
}

// --- List tabs -----------------------------------------------------------------

function AclsTab({ collection, onOpen, onCreate }) {
  const [search, setSearch] = useState("");
  const [defaultAction, setDefaultAction] = useState("all");
  const acls = collection.items;
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return acls.filter((acl) => {
      if (defaultAction !== "all" && acl.defaultAction !== defaultAction) return false;
      return !query || acl.name.toLowerCase().includes(query);
    });
  }, [acls, search, defaultAction]);
  const pager = usePagination(filtered, { resetKey: `${search}|${defaultAction}` });

  const columns = [
    {
      key: "name",
      header: "Web ACL",
      render: (acl) => <div className="flex items-center gap-3">
        <div className={ICON_TILE}><Shield className="h-4 w-4" /></div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-medium text-foreground">{acl.name}</span>
          <span className="truncate text-xs text-text-secondary">Version {acl.version}</span>
        </div>
      </div>,
    },
    { key: "default", header: "Default action", render: (acl) => <StatusPill status={acl.defaultAction} map={DEFAULT_ACTION_MAP} /> },
    { key: "rules", header: "Rules", align: "right", render: (acl) => <span className="text-sm tabular-nums text-text-secondary">{(acl.rules ?? []).length}</span> },
    { key: "updated", header: "Updated", render: (acl) => <span className="text-sm tabular-nums text-text-secondary">{formatDate(acl.updatedAt ?? acl.createdAt)}</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (acl) => <ActionMenu
        label={`Actions for ${acl.name}`}
        items={[
          { icon: Pencil, label: "Open", onSelect: () => onOpen(acl) },
          { icon: Copy, label: "Copy ID", onSelect: () => copyId(acl.id) },
        ]}
      />,
    },
  ];

  return <>
    <Toolbar>
      <div className="flex flex-wrap items-center gap-2">
        <FilterDropdown label="Default action" value={defaultAction} onValueChange={setDefaultAction} options={DEFAULT_ACTION_FILTER} height="h-9" />
      </div>
      <SearchInput value={search} onChange={setSearch} placeholder="Search web ACLs…" />
    </Toolbar>
    {collection.status === "loading" ? <LoadingArea panel label="Loading web ACLs" /> : null}
    {collection.status === "error" ? <ErrorPanel icon={Shield} title="Could not load web ACLs" error={collection.error} onRetry={collection.retry} /> : null}
    {collection.status === "ready" ? <div className="space-y-5">
      <DataTable
        columns={columns}
        data={pager.pageItems}
        getRowKey={(acl) => acl.id}
        onRowClick={onOpen}
        empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
          icon={Shield}
          title={acls.length ? "No web ACLs match your filters" : "No web ACLs yet"}
          description={acls.length ? "Try clearing the search or default action filter." : "Create one, add rules, then associate it with an API stage."}
          action={acls.length ? null : <Button className={PRIMARY_CLASS} onClick={onCreate}><Plus className="h-4 w-4" /> New Web ACL</Button>}
        /></div>}
      />
      <ListPagination {...pager} itemLabel="web ACLs" />
    </div> : null}
  </>;
}

function entrySummary(entries) {
  if (entries.length === 0) return "No entries";
  const head = entries.slice(0, 3).join(", ");
  return entries.length > 3 ? `${head} +${entries.length - 3} more` : head;
}

function SetsTab({ kind, collection, onCreate }) {
  const meta = SET_KINDS[kind];
  const Icon = meta.icon;
  const [search, setSearch] = useState("");
  const sets = collection.items;
  const entriesOf = (set) => set.addresses ?? set.patterns ?? [];
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return sets.filter((set) => !query || `${set.name} ${(set.addresses ?? set.patterns ?? []).join(" ")}`.toLowerCase().includes(query));
  }, [sets, search]);
  const pager = usePagination(filtered, { resetKey: search });

  const columns = [
    {
      key: "name",
      header: meta.singular,
      render: (set) => <div className="flex items-center gap-3">
        <div className={ICON_TILE}><Icon className="h-4 w-4" /></div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-medium text-foreground">{set.name}</span>
          <span className="truncate font-mono text-xs text-text-secondary">{set.id}</span>
        </div>
      </div>,
    },
    kind === "ip" && { key: "ipVersion", header: "Version", render: (set) => <Badge variant="neutral">{set.ipVersion}</Badge> },
    { key: "entries", header: meta.entriesLabel, render: (set) => <span className="font-mono text-xs text-text-secondary">{entrySummary(entriesOf(set))}</span> },
    { key: "count", header: "Entries", align: "right", render: (set) => <span className="text-sm tabular-nums text-text-secondary">{entriesOf(set).length}</span> },
    { key: "updated", header: "Updated", render: (set) => <span className="text-sm tabular-nums text-text-secondary">{formatDate(set.updatedAt ?? set.createdAt)}</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (set) => <ActionMenu label={`Actions for ${set.name}`} items={[{ icon: Copy, label: "Copy ID", onSelect: () => copyId(set.id) }]} />,
    },
  ].filter(Boolean);

  return <>
    <Toolbar>
      <div />
      <SearchInput value={search} onChange={setSearch} placeholder={`Search ${meta.plural}…`} />
    </Toolbar>
    {collection.status === "loading" ? <LoadingArea panel label={`Loading ${meta.plural}`} /> : null}
    {collection.status === "error" ? <ErrorPanel icon={Icon} title={`Could not load ${meta.plural}`} error={collection.error} onRetry={collection.retry} /> : null}
    {collection.status === "ready" ? <div className="space-y-5">
      <DataTable
        columns={columns}
        data={pager.pageItems}
        getRowKey={(set) => set.id}
        empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
          icon={Icon}
          title={sets.length ? `No ${meta.plural} match your search` : `No ${meta.plural} yet`}
          description={sets.length
            ? "Try clearing the search."
            : kind === "ip"
              ? "Group IPv4 ranges once and reference them from any rule by ID."
              : "Group URL or header patterns once and reference them from any rule by ID."}
          action={sets.length ? null : <Button className={PRIMARY_CLASS} onClick={onCreate}><Plus className="h-4 w-4" /> New {meta.singular}</Button>}
        /></div>}
      />
      <ListPagination {...pager} itemLabel={meta.plural} />
    </div> : null}
  </>;
}

// --- Screen ----------------------------------------------------------------------

export function WafScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const projectId = project?.id;
  const [recordId, setRecordId] = useRecordParam();
  const [tab, setTab] = useState("acls");
  const [creatingAcl, setCreatingAcl] = useState(false);
  const [creatingSet, setCreatingSet] = useState(null);
  const acls = useCollection(projectId, "/web-acls");
  const ipSets = useCollection(projectId, "/ip-sets");
  const regexSets = useCollection(projectId, "/regex-sets");

  const setNames = useMemo(
    () => new Map([...ipSets.items, ...regexSets.items].map((set) => [set.id, set.name])),
    [ipSets.items, regexSets.items],
  );

  const stats = useMemo(() => [
    { label: "Web ACLs", value: String(acls.items.length), footer: "Rule bundles for stages" },
    { label: "Rules", value: String(acls.items.reduce((sum, acl) => sum + (acl.rules ?? []).length, 0)), footer: "Across all web ACLs" },
    { label: "IP sets", value: String(ipSets.items.length), footer: "Reusable address lists" },
    { label: "Regex sets", value: String(regexSets.items.length), footer: "Reusable pattern lists" },
  ], [acls.items, ipSets.items, regexSets.items]);

  if (!can("pods.domains.view")) {
    return <MainScreenWrapper>
      <ScreenHeader title="Web Application Firewall" description="Filter requests to your API stages with ordered rules." />
      <div className="rounded-xl border border-border bg-surface-subtle">
        <EmptyState icon={LockKeyhole} title="Access unavailable" description="Your current team access does not allow this screen." />
      </div>
    </MainScreenWrapper>;
  }

  if (recordId) {
    return <AclEditPage
      key={recordId}
      projectId={projectId}
      aclId={recordId}
      setNames={setNames}
      onBack={() => setRecordId(null)}
      onChanged={acls.refresh}
    />;
  }

  const createAction = tab === "acls"
    ? <Button className={PRIMARY_CLASS} onClick={() => setCreatingAcl(true)}><Plus className="h-4 w-4" /> New Web ACL</Button>
    : <Button className={PRIMARY_CLASS} onClick={() => setCreatingSet(tab)}><Plus className="h-4 w-4" /> New {SET_KINDS[tab].singular}</Button>;

  const counts = { acls: acls.items.length, ip: ipSets.items.length, regex: regexSets.items.length };

  return <MainScreenWrapper>
    <ScreenHeader
      title="Web Application Firewall"
      description="Web ACLs filter requests to your API stages with ordered rules. IP sets and regex sets hold the addresses and patterns those rules match."
      actions={createAction}
    />

    <StatsBar stats={stats} />

    <div className="flex items-center gap-1 border-b border-border">
      {TABS.map((entry) => <button
        key={entry.key}
        type="button"
        onClick={() => setTab(entry.key)}
        className={cn(
          "relative px-3 py-2 text-sm font-medium transition-colors",
          tab === entry.key ? "text-foreground" : "text-text-secondary hover:text-foreground",
        )}
      >
        {entry.label}
        {counts[entry.key] ? <span className="ml-1.5 text-xs text-text-tertiary">{counts[entry.key]}</span> : null}
        {tab === entry.key ? <span className="absolute inset-x-0 -bottom-px h-0.5 bg-primary" /> : null}
      </button>)}
    </div>

    {tab === "acls"
      ? <AclsTab collection={acls} onOpen={(acl) => setRecordId(acl.id)} onCreate={() => setCreatingAcl(true)} />
      : <SetsTab
        key={tab}
        kind={tab}
        collection={tab === "ip" ? ipSets : regexSets}
        onCreate={() => setCreatingSet(tab)}
      />}

    <CreateAclDialog
      projectId={projectId}
      open={creatingAcl}
      onOpenChange={setCreatingAcl}
      onCreated={async (created) => {
        await acls.refresh();
        if (created?.id) setRecordId(created.id);
      }}
    />
    <CreateSetDialog
      projectId={projectId}
      kind={creatingSet}
      onOpenChange={(open) => { if (!open) setCreatingSet(null); }}
      onCreated={() => (creatingSet === "ip" ? ipSets.refresh() : regexSets.refresh())}
    />
  </MainScreenWrapper>;
}
