"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, LockKeyhole, Plus, RotateCw } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";

const SECRET_KINDS = [
  "generic",
  "header",
  "basic_auth",
  "bearer",
  "aws_credentials",
  "client_certificate",
  "private_key",
  "oauth_client",
];

// One textarea per value field; values are write-only and never rendered back.
const KIND_FIELDS = {
  generic: [{ key: "value", label: "Value", multiline: true }],
  header: [{ key: "name", label: "Header name" }, { key: "value", label: "Header value", multiline: true }],
  basic_auth: [{ key: "username", label: "Username" }, { key: "password", label: "Password", secret: true }],
  bearer: [{ key: "token", label: "Token", secret: true }],
  aws_credentials: [
    { key: "accessKeyId", label: "Access key ID" },
    { key: "secretAccessKey", label: "Secret access key", secret: true },
    { key: "sessionToken", label: "Session token (optional)", secret: true, optional: true },
    { key: "region", label: "Region (optional)", optional: true },
  ],
  client_certificate: [
    { key: "certificatePem", label: "Certificate PEM", multiline: true },
    { key: "privateKeyPem", label: "Private key PEM", multiline: true, secret: true },
    { key: "passphrase", label: "Passphrase (optional)", secret: true, optional: true },
  ],
  private_key: [
    { key: "pem", label: "Private key PEM", multiline: true, secret: true },
    { key: "passphrase", label: "Passphrase (optional)", secret: true, optional: true },
  ],
  oauth_client: [
    { key: "tokenUrl", label: "Token URL" },
    { key: "clientId", label: "Client ID" },
    { key: "clientSecret", label: "Client secret", secret: true },
    { key: "scope", label: "Scope (optional)", optional: true },
    { key: "audience", label: "Audience (optional)", optional: true },
  ],
};

async function api(projectId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/secrets${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

function useSecrets(projectId) {
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const refresh = useCallback(async () => {
    setState({ status: "loading", items: [], error: null });
    try {
      const data = await api(projectId, "");
      setState({ status: "ready", items: data.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [projectId]);
  useEffect(() => {
    let alive = true;
    api(projectId, "").then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [projectId]);
  return { ...state, refresh };
}

function SecretForm({ initial, onSubmit, submitting, submitLabel }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState(initial?.kind ?? "bearer");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [fields, setFields] = useState({});
  const kindFields = KIND_FIELDS[kind] ?? [];
  return <form className="space-y-4" onSubmit={(event) => {
    event.preventDefault();
    const value = {};
    for (const field of kindFields) {
      const entry = (fields[field.key] ?? "").trim();
      if (entry) value[field.key] = entry;
    }
    onSubmit({ name: name.trim(), kind, description: description.trim() || undefined, value });
  }}>
    <div className="space-y-2">
      <Label htmlFor="secret-name">Name</Label>
      <Input id="secret-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="upstream-api-key" required />
    </div>
    <div className="space-y-2">
      <Label>Kind</Label>
      <Select value={kind} onValueChange={(next) => { setKind(next); setFields({}); }}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>{SECRET_KINDS.map((entry) => <SelectItem key={entry} value={entry}>{entry}</SelectItem>)}</SelectContent>
      </Select>
    </div>
    <div className="space-y-2">
      <Label htmlFor="secret-description">Description (optional)</Label>
      <Input id="secret-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this credential is for" />
    </div>
    {kindFields.map((field) => <div key={field.key} className="space-y-2">
      <Label htmlFor={`secret-${field.key}`}>{field.label}{field.optional ? "" : " *"}</Label>
      {field.multiline
        ? <Textarea id={`secret-${field.key}`} value={fields[field.key] ?? ""} onChange={(event) => setFields((current) => ({ ...current, [field.key]: event.target.value }))} rows={3} autoComplete="off" spellCheck={false} />
        : <Input id={`secret-${field.key}`} type={field.secret ? "password" : "text"} value={fields[field.key] ?? ""} onChange={(event) => setFields((current) => ({ ...current, [field.key]: event.target.value }))} autoComplete="off" spellCheck={false} />}
    </div>)}
    <p className="text-xs text-muted-foreground">Values are write-only: they are encrypted on save and never displayed again.</p>
    <DialogFooter>
      <Button type="submit" disabled={submitting}>{submitLabel}</Button>
    </DialogFooter>
  </form>;
}

export function SecretsScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const { status, items, error, refresh } = useSecrets(project.id);
  const [creating, setCreating] = useState(false);
  const [rotating, setRotating] = useState(null);
  const [versionsFor, setVersionsFor] = useState(null);
  const [versions, setVersions] = useState(null);
  const [busy, setBusy] = useState(false);
  const writable = can("pods.secret.write");

  const mutate = async (work, success) => {
    setBusy(true);
    try {
      await work();
      toast.success(success);
      await refresh();
    } catch (mutationError) {
      toast.error(mutationError.message);
    } finally {
      setBusy(false);
    }
  };

  const openVersions = async (secret) => {
    setVersionsFor(secret);
    setVersions(null);
    try {
      const detail = await api(project.id, `/${encodeURIComponent(secret.id)}`);
      setVersions(detail.versions ?? []);
    } catch (loadError) {
      toast.error(loadError.message);
      setVersionsFor(null);
    }
  };

  const disableVersion = (secret, version) => mutate(
    () => api(project.id, `/${encodeURIComponent(secret.id)}/versions/${encodeURIComponent(String(version))}/disable`, { method: "POST" }),
    `Disabled ${secret.name} v${version}.`,
  ).then(() => openVersions(secret));

  const tryDelete = (secret) => {
    if ((secret.usedBy ?? 0) > 0) {
      toast.error(`Secret "${secret.name}" is still referenced by ${secret.usedBy} configuration row(s); detach it first.`);
      return;
    }
    return mutate(
      () => api(project.id, `/${encodeURIComponent(secret.id)}`, { method: "DELETE" }),
      `Deleted ${secret.name}.`,
    );
  };

  if (!writable) {
    return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
      <ScreenHeader title="Secrets" description="Backend credentials for your integrations." />
      <SectionCard><EmptyState icon={LockKeyhole} title="Access unavailable" description="Your current team access does not allow this screen." /></SectionCard>
    </div>;
  }

  return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
    <ScreenHeader
      title="Secrets"
      description="Backend credentials, encrypted at rest. Values are write-only and referenced by integrations, never pasted into config."
      actions={<Button onClick={() => setCreating(true)}><Plus className="size-4" />New secret</Button>}
    />
    {status === "loading" ? <SectionCard><div className="flex justify-center py-10"><LogoLoading /></div></SectionCard> : null}
    {status === "error" ? <SectionCard><EmptyState icon={KeyRound} title="Secrets unavailable" description={error} action={<Button variant="outline" onClick={refresh}>Retry</Button>} /></SectionCard> : null}
    {status === "ready" && items.length === 0 ? <SectionCard><EmptyState icon={KeyRound} title="No secrets yet" description="Store your first upstream credential. It is encrypted before it touches the database." action={<Button onClick={() => setCreating(true)}>New secret</Button>} /></SectionCard> : null}
    {status === "ready" && items.length > 0 ? <SectionCard title="Secrets" description={`${items.length} stored credential${items.length === 1 ? "" : "s"}.`}>
      <ul className="divide-y divide-border">
        {items.map((secret) => <li key={secret.id} className="flex flex-wrap items-center gap-3 py-4 first:pt-0 last:pb-0">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{secret.name}</p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">{secret.kind}</Badge>
              <span>ending {secret.fingerprint}</span>
              <span>v{secret.currentVersion}</span>
              <span>rotated {secret.lastRotatedAt ? new Date(secret.lastRotatedAt).toLocaleDateString() : "never"}</span>
              {secret.usedBy > 0 ? <span>used by {secret.usedBy}</span> : null}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setRotating(secret)}><RotateCw className="size-4" />Rotate</Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => openVersions(secret)}>Versions</Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              title={secret.usedBy > 0 ? `Used by ${secret.usedBy} configuration row(s); detach first.` : undefined}
              onClick={() => tryDelete(secret)}
            >Delete</Button>
          </div>
        </li>)}
      </ul>
    </SectionCard> : null}
    <Dialog open={creating} onOpenChange={setCreating}>
      <DialogContent>
        <DialogHeader><DialogTitle>New secret</DialogTitle><DialogDescription>Write-only: the value is encrypted on save and never shown again.</DialogDescription></DialogHeader>
        <SecretForm
          submitting={busy}
          submitLabel={busy ? "Saving…" : "Save secret"}
          onSubmit={(input) => mutate(
            () => api(project.id, "", { method: "POST", body: JSON.stringify(input) }),
            `Saved ${input.name}.`,
          ).then(() => setCreating(false))}
        />
      </DialogContent>
    </Dialog>
    <Dialog open={rotating !== null} onOpenChange={(open) => { if (!open) setRotating(null); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Rotate {rotating?.name}</DialogTitle><DialogDescription>The previous version stays valid until you disable it.</DialogDescription></DialogHeader>
        {rotating ? <SecretForm
          initial={{ name: rotating.name, kind: rotating.kind }}
          submitting={busy}
          submitLabel={busy ? "Rotating…" : "Save new version"}
          onSubmit={(input) => mutate(
            () => api(project.id, `/${encodeURIComponent(rotating.id)}/rotate`, { method: "POST", body: JSON.stringify({ value: input.value }) }),
            `Rotated ${rotating.name} to v${rotating.currentVersion + 1}.`,
          ).then(() => setRotating(null))}
        /> : null}
      </DialogContent>
    </Dialog>
    <Dialog open={versionsFor !== null} onOpenChange={(open) => { if (!open) { setVersionsFor(null); setVersions(null); } }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Versions of {versionsFor?.name}</DialogTitle><DialogDescription>Disable an old version to stop resolving it. The current version cannot be disabled; rotate first.</DialogDescription></DialogHeader>
        {versions === null ? <p className="text-sm text-muted-foreground">Loading versions…</p> : null}
        {versions !== null && versions.length === 0 ? <p className="text-sm text-muted-foreground">No versions found.</p> : null}
        {versions !== null && versions.length > 0 ? <ul className="space-y-2">
          {versions.map((entry) => <li key={entry.version} className="flex items-center gap-2 text-sm">
            <span className="font-medium">v{entry.version}</span>
            {entry.version === versionsFor?.currentVersion ? <Badge variant="outline">current</Badge> : null}
            {entry.disabledAt ? <Badge variant="outline">disabled</Badge> : <Badge variant="outline">enabled</Badge>}
            <span className="ml-auto" />
            {!entry.disabledAt && entry.version !== versionsFor?.currentVersion ? <Button variant="outline" size="sm" disabled={busy} onClick={() => disableVersion(versionsFor, entry.version)}>Disable</Button> : null}
          </li>)}
        </ul> : null}
      </DialogContent>
    </Dialog>
  </div>;
}
