"use client";

// Signing credentials: project-level SigV4 access keys (the IAM equivalent).
// Create shows the secret access key once with SDK snippets; each credential
// opens in place with its identity policies (JSON, validated client-side
// before the server's own per-path schema errors).

import { useCallback, useEffect, useMemo, useState } from "react";
import { BadgeCheck, Ban, Copy, FileJson, KeyRound, Loader2, LockKeyhole, Pencil, Plus, Trash2, Unlink } from "lucide-react";
import {
  DataTable, EmptyState, Field, LoadingArea, ScreenHeader, SearchInput, SectionCard, SegmentedTabs, StatsBar, StatusPill, Toolbar,
} from "@/components/internal/shared/screen_kit";
import { MainScreenWrapper } from "@/components/internal/shared/screen_wrappers";
import { ListPagination, usePagination } from "@/components/internal/shared/pagination";
import { EditorHeader, EditorShell } from "@/components/internal/shared/editor_shell";
import FilterDropdown from "@/components/internal/screens/overview/filter_dropdown";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Switch } from "@geiger/ui/switch";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { useRecordParam } from "@/lib/hooks/use-record-param";
import { validatePolicyJson } from "@/lib/workspace/auth-ui.mjs";

const STATUS_MAP = {
  ACTIVE: { label: "Active", variant: "success", dotClass: "bg-emerald-400" },
  INACTIVE: { label: "Inactive", variant: "neutral", dotClass: "bg-[#737373]" },
};

const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "All Statuses" },
  { value: "ACTIVE", label: "Active" },
  { value: "INACTIVE", label: "Inactive" },
];

const SNIPPET_TABS = [
  { value: "js", label: "@smithy/signature-v4" },
  { value: "py", label: "Python botocore" },
];

const MAX_POLICIES = 10;
const DEFAULT_POLICY = '{\n  "Version": "2012-10-17",\n  "Statement": []\n}';

const CANCEL_CLASS = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";
const PRIMARY_CLASS = "bg-primary text-primary-foreground hover:bg-primary/90";
const DANGER_CLASS = "bg-red-500/90 text-white hover:bg-red-500";

const formatDate = (value) => (value ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—");
const formatDateTime = (value) => (value ? new Date(value).toLocaleString() : "Never");

async function api(projectId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/signing-credentials${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

function copyText(text, label) {
  navigator.clipboard?.writeText(text).then(
    () => toast.success(`${label} copied.`),
    () => toast.error("Copy failed."),
  );
}

function jsSnippet(credential, secret) {
  return `import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@smithy/smithy-client";

const signer = new SignatureV4({
  service: "execute-api",
  region: "auto",
  credentials: { accessKeyId: "${credential.accessKeyId}", secretAccessKey: "${secret}" },
  sha256: Sha256,
});
// Sign any request to https://<apiPublicId>.<gateway>/<stage>/<path>`;
}

function pythonSnippet(credential, secret) {
  return `from botocore.auth import SigV4Auth
from botocore.credentials import Credentials
import botocore.awsrequest

creds = Credentials("${credential.accessKeyId}", "${secret}")
request = botocore.awsrequest.AWSRequest(
    method="GET", url="https://<apiPublicId>.<gateway>/<stage>/<path>")
SigV4Auth(creds, "execute-api", "auto").add_auth(request)
# Send request.prepare() with your HTTP client`;
}

function CopyField({ id, label, value }) {
  return <Field label={label} htmlFor={id}>
    <div className="flex items-center gap-2">
      <Input id={id} readOnly value={value} spellCheck={false} onFocus={(event) => event.target.select()} className="font-mono text-xs" />
      <Button variant="ghost" size="icon-sm" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => copyText(value, label)}>
        <Copy className="h-4 w-4" />
      </Button>
    </div>
  </Field>;
}

// Shown once, right after create: the secret is never returned by GET.
function OnceSecretDialog({ created, onOpenChange }) {
  const [snippet, setSnippet] = useState("js");
  const secret = created?.secretAccessKey;
  const build = snippet === "js" ? jsSnippet : pythonSnippet;
  return <Dialog open={!!secret} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-xl bg-background">
      <DialogHeader>
        <DialogTitle>Copy Your Secret Access Key</DialogTitle>
        <DialogDescription>It&apos;s shown once and never returned again — like an AWS secret key.</DialogDescription>
      </DialogHeader>
      {secret ? <div className="grid gap-4">
        <CopyField id="cred-once-key" label="Access key ID" value={created.accessKeyId ?? ""} />
        <CopyField id="cred-once-secret" label="Secret access key" value={secret} />
        <p className="text-xs text-amber-600 dark:text-amber-400">Store it somewhere safe before closing this dialog. You can&apos;t view it again.</p>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SegmentedTabs tabs={SNIPPET_TABS} value={snippet} onChange={setSnippet} />
            <Button variant="outline" size="sm" onClick={() => copyText(build(created, secret), "Snippet")}>
              <Copy className="h-4 w-4" /> Copy snippet
            </Button>
          </div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-surface-card p-3 font-mono text-xs text-foreground">
            {build(created, "••••")}
          </pre>
        </div>
      </div> : null}
      <DialogFooter>
        <Button className={PRIMARY_CLASS} onClick={() => onOpenChange(false)}>Done</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function CreateCredentialDialog({ projectId, open, onOpenChange, onCreated }) {
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);

  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setName("");
      setExpiresAt("");
    }
  }

  const submit = async (event) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Give the credential a name first.");
      return;
    }
    setBusy(true);
    try {
      const result = await api(projectId, "", {
        method: "POST",
        body: JSON.stringify({ name: trimmed, ...(expiresAt.trim() ? { expiresAt: expiresAt.trim() } : {}) }),
      });
      onOpenChange(false);
      toast.success("Credential created — copy the secret now.");
      onCreated(result.body ?? result);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md bg-background">
      <DialogHeader>
        <DialogTitle>New Signing Credential</DialogTitle>
        <DialogDescription>The secret access key is shown once. Access key IDs start with PKIA.</DialogDescription>
      </DialogHeader>
      <form className="grid gap-4" onSubmit={submit}>
        <Field label="Name" htmlFor="cred-name">
          <Input id="cred-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="deploy-bot" autoFocus />
        </Field>
        <Field label="Expires at (optional)" htmlFor="cred-expiry">
          <Input id="cred-expiry" type="date" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" className={CANCEL_CLASS} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" className={PRIMARY_CLASS} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Create Credential
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

function ConfirmDialog({ open, title, children, confirmLabel, icon: Icon = Trash2, busy, onCancel, onConfirm }) {
  return <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{children}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button className={DANGER_CLASS} disabled={busy} onClick={onConfirm}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />} {confirmLabel}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function Policies({ credential, writable }) {
  const { project } = useProject();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [name, setName] = useState("");
  const [text, setText] = useState(DEFAULT_POLICY);
  const [busy, setBusy] = useState(false);
  const [detachTarget, setDetachTarget] = useState(null);
  const base = `/${encodeURIComponent(credential.id)}/policies`;

  const refresh = useCallback(async () => {
    try {
      const data = await api(project.id, base);
      setState({ status: "ready", items: data.items ?? data ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [project.id, base]);

  useEffect(() => {
    let alive = true;
    api(project.id, base).then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? data ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id, base]);

  const attach = async () => {
    let document;
    try {
      ({ document } = validatePolicyJson(text));
    } catch (error) {
      toast.error(error.message);
      return;
    }
    if (!name.trim()) {
      toast.error("Policy name is required.");
      return;
    }
    if (state.items.length >= MAX_POLICIES) {
      toast.error(`One credential holds at most ${MAX_POLICIES} policies.`);
      return;
    }
    setBusy(true);
    try {
      await api(project.id, base, { method: "POST", body: JSON.stringify({ name: name.trim(), document }) });
      toast.success(`Attached ${name.trim()}.`);
      setName("");
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const detach = async () => {
    const policy = detachTarget;
    setBusy(true);
    try {
      await api(project.id, `${base}/${encodeURIComponent(policy.id)}`, { method: "DELETE" });
      toast.success(`Detached ${policy.name}.`);
      setDetachTarget(null);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const columns = [
    {
      key: "name",
      header: "Policy",
      render: (policy) => <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-card text-muted-foreground">
          <FileJson className="h-4 w-4" />
        </div>
        <span className="font-medium text-foreground">{policy.name}</span>
      </div>,
    },
    {
      key: "statements",
      header: "Statements",
      align: "right",
      render: (policy) => <span className="text-sm tabular-nums text-text-secondary">{(policy.document?.Statement ?? []).length}</span>,
    },
    { key: "updated", header: "Updated", render: (policy) => <span className="text-sm tabular-nums text-text-secondary">{formatDate(policy.updatedAt ?? policy.createdAt)}</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (policy) => <ActionMenu
        label={`Actions for ${policy.name}`}
        items={[writable && { icon: Unlink, label: "Detach", destructive: true, onSelect: () => setDetachTarget(policy) }]}
      />,
    },
  ];

  return <div className="space-y-6">
    <SectionCard
      title={`Attached policies (${state.items.length}/${MAX_POLICIES})`}
      description="An explicit Deny beats Allow; anything not allowed is implicitly denied."
      bodyPadding={false}
    >
      {state.status === "loading" ? <LoadingArea label="Loading policies" size={32} /> : null}
      {state.status === "error" ? <EmptyState
        icon={FileJson}
        title="Policies unavailable"
        description={state.error}
        action={<Button variant="outline" onClick={() => { setState({ status: "loading", items: [], error: null }); refresh(); }}>Retry</Button>}
      /> : null}
      {state.status === "ready" ? <DataTable
        className="rounded-none border-0"
        columns={columns}
        data={state.items}
        getRowKey={(policy) => policy.id}
        empty={<EmptyState
          icon={FileJson}
          title="No policies"
          description="This credential is implicitly denied everywhere until a policy allows it."
        />}
      /> : null}
    </SectionCard>

    {writable ? <SectionCard
      title="Attach policy"
      description="Paste an identity policy document. It's validated before it's sent."
      action={<Button className={PRIMARY_CLASS} disabled={busy} onClick={attach}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Attach Policy
      </Button>}
    >
      <div className="grid gap-4">
        <Field label="Name" htmlFor="policy-name">
          <Input id="policy-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="read-only-pets" />
        </Field>
        <Field label="Policy document (JSON)" htmlFor="policy-document">
          <Textarea id="policy-document" rows={10} value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} className="font-mono text-xs" />
        </Field>
      </div>
    </SectionCard> : null}

    <ConfirmDialog
      open={!!detachTarget}
      title="Detach policy"
      confirmLabel="Detach"
      icon={Unlink}
      busy={busy}
      onCancel={() => setDetachTarget(null)}
      onConfirm={detach}
    >
      Detach <span className="font-medium text-foreground">{detachTarget?.name}</span>? Requests it allowed are denied unless another
      policy allows them.
    </ConfirmDialog>
  </div>;
}

const SECTIONS = [{
  group: null,
  items: [
    { key: "overview", label: "Overview", icon: KeyRound, desc: "Access key, principal and lifecycle." },
    { key: "policies", label: "Policies", icon: FileJson, desc: "Identity policies that decide what this credential may call." },
  ],
}];

function CredentialEditPage({ projectId, credential, writable, busy, onBack, onFlip, onDelete }) {
  const principal = `arn:pods:iam::${projectId}:credential/${credential.accessKeyId}`;
  const facts = [
    { label: "Access key ID", value: <span className="font-mono text-xs">{credential.accessKeyId}</span> },
    { label: "Status", value: STATUS_MAP[credential.status]?.label ?? credential.status },
    { label: "Last used", value: formatDateTime(credential.lastUsedAt) },
    { label: "Expires", value: credential.expiresAt ? formatDate(credential.expiresAt) : "Never" },
    { label: "Created", value: formatDate(credential.createdAt) },
    { label: "Principal", value: <span className="break-all font-mono text-xs">{principal}</span> },
  ];
  const active = credential.status === "ACTIVE";

  return <EditorShell
    back={{ label: "All Signing Credentials", onClick: onBack }}
    title={credential.name}
    status={credential.status}
    statusMap={STATUS_MAP}
    badges={<>
      <span className="font-mono text-xs text-text-secondary">{credential.accessKeyId}</span>
      <Button variant="ghost" size="icon-sm" aria-label="Copy access key ID" onClick={() => copyText(credential.accessKeyId, "Access key ID")}>
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </>}
    actions={writable ? <label className="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-border bg-transparent px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface-active hover:text-foreground">
      {active ? "Active" : "Inactive"}
      <Switch checked={active} disabled={busy} onCheckedChange={() => onFlip(credential)} />
    </label> : null}
    nav={SECTIONS}
    defaultSection="overview"
  >
    {({ active: section }) => section === "policies"
      ? <Policies key={credential.id} credential={credential} writable={writable} />
      : <div className="space-y-6">
        <SectionCard title="Details">
          <dl className="grid gap-4 sm:grid-cols-2">
            {facts.map((fact) => <div key={fact.label}>
              <dt className="text-xs text-text-secondary">{fact.label}</dt>
              <dd className="mt-1 text-sm text-foreground">{fact.value}</dd>
            </div>)}
          </dl>
        </SectionCard>
        {writable ? <SectionCard title="Danger zone">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Delete this credential</p>
              <p className="mt-0.5 text-xs text-text-secondary">Requests signed with this access key are rejected immediately.</p>
            </div>
            <Button
              variant="outline"
              className="border-red-500/30 text-red-600 hover:bg-red-500/10 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
              onClick={() => onDelete(credential)}
            ><Trash2 className="h-4 w-4" /> Delete</Button>
          </div>
        </SectionCard> : null}
      </div>}
  </EditorShell>;
}

export function SigningCredentialsScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [recordId, setRecordId] = useRecordParam();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const writable = can("pods.secret.write");

  const refresh = useCallback(async () => {
    try {
      const data = await api(project.id, "");
      setState({ status: "ready", items: data.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [project.id]);

  useEffect(() => {
    let alive = true;
    api(project.id, "").then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id]);

  const items = state.items;
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items.filter((credential) => {
      if (status !== "all" && credential.status !== status) return false;
      return !query || `${credential.name} ${credential.accessKeyId}`.toLowerCase().includes(query);
    });
  }, [items, search, status]);

  const pager = usePagination(filtered, { resetKey: `${search}|${status}` });

  const stats = useMemo(() => {
    const active = items.filter((credential) => credential.status === "ACTIVE").length;
    return [
      { label: "Credentials", value: String(items.length), footer: "In this project" },
      { label: "Active", value: String(active), footer: "Can sign requests" },
      { label: "Inactive", value: String(items.length - active), footer: "Rejected by the gateway" },
      { label: "Never used", value: String(items.filter((credential) => !credential.lastUsedAt).length), footer: "No signed request yet" },
    ];
  }, [items]);

  if (!can("pods.secrets.view") && !writable) {
    return <MainScreenWrapper>
      <ScreenHeader title="Signing Credentials" description="SigV4 credentials for signed API requests." />
      <div className="rounded-xl border border-border bg-surface-subtle">
        <EmptyState icon={LockKeyhole} title="Access unavailable" description="Your current team access does not allow this screen." />
      </div>
    </MainScreenWrapper>;
  }

  const flip = async (credential) => {
    const next = credential.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    setBusy(true);
    try {
      await api(project.id, `/${encodeURIComponent(credential.id)}`, {
        method: "PATCH",
        headers: { "If-Match": String(credential.version) },
        body: JSON.stringify({ status: next }),
      });
      toast.success(`${credential.accessKeyId} is now ${next}.`);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const credential = deleteTarget;
    setBusy(true);
    try {
      await api(project.id, `/${encodeURIComponent(credential.id)}`, { method: "DELETE" });
      toast.success(`Deleted "${credential.name}".`);
      setDeleteTarget(null);
      if (recordId === credential.id) setRecordId(null);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const deleteDialog = <ConfirmDialog
    open={!!deleteTarget}
    title="Delete signing credential"
    confirmLabel="Delete"
    busy={busy}
    onCancel={() => setDeleteTarget(null)}
    onConfirm={remove}
  >
    Are you sure you want to delete <span className="font-medium text-foreground">{deleteTarget?.name}</span>? Requests signed with
    it are rejected. This action can&apos;t be undone.
  </ConfirmDialog>;

  const onceDialog = <OnceSecretDialog created={created} onOpenChange={(open) => { if (!open) setCreated(null); }} />;

  if (recordId) {
    const back = () => setRecordId(null);
    const credential = items.find((entry) => entry.id === recordId);
    if (state.status === "loading") return <LoadingArea label="Loading signing credential" />;
    if (!credential) {
      return <MainScreenWrapper>
        <EditorHeader back={{ label: "All Signing Credentials", onClick: back }} title="Credential unavailable" />
        <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
          icon={KeyRound}
          title="Credential unavailable"
          description={state.error ?? "This credential doesn't exist or was deleted."}
          action={state.error ? <Button variant="outline" onClick={() => { setState({ status: "loading", items: [], error: null }); refresh(); }}>Retry</Button> : null}
        /></div>
      </MainScreenWrapper>;
    }
    return <>
      <CredentialEditPage
        projectId={project.id}
        credential={credential}
        writable={writable}
        busy={busy}
        onBack={back}
        onFlip={flip}
        onDelete={setDeleteTarget}
      />
      {deleteDialog}
      {onceDialog}
    </>;
  }

  const openCredential = (credential) => setRecordId(credential.id);

  const columns = [
    {
      key: "name",
      header: "Credential",
      render: (credential) => <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-card text-muted-foreground">
          <KeyRound className="h-4 w-4" />
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-medium text-foreground">{credential.name}</span>
          <span className="truncate font-mono text-xs text-text-secondary">{credential.accessKeyId}</span>
        </div>
      </div>,
    },
    { key: "status", header: "Status", render: (credential) => <StatusPill status={credential.status} map={STATUS_MAP} /> },
    { key: "lastUsed", header: "Last used", render: (credential) => <span className="text-sm tabular-nums text-text-secondary">{formatDateTime(credential.lastUsedAt)}</span> },
    { key: "expires", header: "Expires", render: (credential) => <span className="text-sm tabular-nums text-text-secondary">{credential.expiresAt ? formatDate(credential.expiresAt) : "Never"}</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (credential) => <ActionMenu
        label={`Actions for ${credential.name}`}
        items={[
          { icon: Pencil, label: "Open", onSelect: () => openCredential(credential) },
          { icon: Copy, label: "Copy access key ID", onSelect: () => copyText(credential.accessKeyId, "Access key ID") },
          writable && {
            icon: credential.status === "ACTIVE" ? Ban : BadgeCheck,
            label: credential.status === "ACTIVE" ? "Deactivate" : "Activate",
            disabled: busy,
            onSelect: () => flip(credential),
          },
          writable && { separator: true },
          writable && { icon: Trash2, label: "Delete", destructive: true, onSelect: () => setDeleteTarget(credential) },
        ]}
      />,
    },
  ];

  const createButton = writable
    ? <Button className={PRIMARY_CLASS} onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New Credential</Button>
    : null;

  return <MainScreenWrapper>
    <ScreenHeader
      title="Signing Credentials"
      description="Access keys for signed requests. Standard AWS SigV4 signers sign Pods requests with them; the region is auto."
      actions={createButton}
    />

    <StatsBar stats={stats} />

    <Toolbar>
      <div className="flex flex-wrap items-center gap-2">
        <FilterDropdown label="Status" value={status} onValueChange={setStatus} options={STATUS_FILTER_OPTIONS} height="h-9" />
      </div>
      <SearchInput value={search} onChange={setSearch} placeholder="Search credentials, access key IDs…" />
    </Toolbar>

    {state.status === "loading" ? <LoadingArea label="Loading signing credentials" /> : null}
    {state.status === "error" ? <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={KeyRound}
      title="Credentials unavailable"
      description={state.error}
      action={<Button variant="outline" onClick={() => { setState({ status: "loading", items: [], error: null }); refresh(); }}>Retry</Button>}
    /></div> : null}
    {state.status === "ready" ? <div className="space-y-5">
      <DataTable
        columns={columns}
        data={pager.pageItems}
        getRowKey={(credential) => credential.id}
        onRowClick={openCredential}
        empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
          icon={KeyRound}
          title={items.length ? "No credentials match your filters" : "No signing credentials yet"}
          description={items.length
            ? "Try clearing the search or status filter."
            : "Create one, copy the secret once, and sign requests with any AWS SigV4 signer."}
          action={items.length ? null : createButton}
        /></div>}
      />
      <ListPagination {...pager} itemLabel="credentials" />
    </div> : null}

    {writable ? <CreateCredentialDialog
      projectId={project.id}
      open={creating}
      onOpenChange={setCreating}
      onCreated={(result) => { setCreated(result); void refresh(); }}
    /> : null}
    {onceDialog}
    {deleteDialog}
  </MainScreenWrapper>;
}
