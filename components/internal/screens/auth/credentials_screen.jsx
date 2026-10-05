"use client";

// Signing credentials screen (S07 §8, `/access/credentials`): project-level
// SigV4 credentials (the IAM equivalent). Create shows the secret access key
// once with copy buttons and SDK snippets (`@smithy/signature-v4`, Python
// `botocore`); the list shows status, last used and expiry. Policies attach
// per credential through a JSON editor with client-side validation
// (server-side schema errors surface per path).

import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound, LockKeyhole, Plus } from "lucide-react";
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
import { validatePolicyJson } from "@/lib/workspace/auth-ui.mjs";

async function api(projectId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/signing-credentials${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
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

function OnceSecret({ created }) {
  const [snippet, setSnippet] = useState("js");
  if (!created?.secretAccessKey) return null;
  return <SectionCard title="Copy the secret access key now" description="It is shown once and never returned by GET — like an AWS secret key.">
    <div className="flex items-center gap-2">
      <Input readOnly value={created.secretAccessKey} spellCheck={false} onFocus={(event) => event.target.select()} className="font-mono" />
      <Button variant="outline" size="sm" onClick={() => {
        navigator.clipboard?.writeText(created.secretAccessKey).then(
          () => toast.success("Secret copied."),
          () => toast.error("Copy failed."),
        );
      }}><Copy className="size-4" />Copy</Button>
    </div>
    <div className="flex gap-2 pt-3">
      <Button variant={snippet === "js" ? "default" : "outline"} size="sm" onClick={() => setSnippet("js")}>@smithy/signature-v4</Button>
      <Button variant={snippet === "py" ? "default" : "outline"} size="sm" onClick={() => setSnippet("py")}>Python botocore</Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          const text = snippet === "js" ? jsSnippet(created, created.secretAccessKey) : pythonSnippet(created, created.secretAccessKey);
          navigator.clipboard?.writeText(text).then(
            () => toast.success("Snippet copied."),
            () => toast.error("Copy failed."),
          );
        }}
      ><Copy className="size-4" />Copy snippet</Button>
    </div>
    <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 font-mono text-xs">
      {snippet === "js" ? jsSnippet(created, "••••") : pythonSnippet(created, "••••")}
    </pre>
  </SectionCard>;
}

function Policies({ credential }) {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [name, setName] = useState("");
  const [text, setText] = useState('{\n  "Version": "2012-10-17",\n  "Statement": []\n}');
  const [busy, setBusy] = useState(false);
  const writable = can("pods.secret.write");
  const base = `/${encodeURIComponent(credential.id)}/policies`;

  const refresh = useCallback(async () => {
    setState({ status: "loading", items: [], error: null });
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
    if (state.items.length >= 10) {
      toast.error("One credential holds at most 10 policies.");
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

  const remove = async (policy) => {
    setBusy(true);
    try {
      await api(project.id, `${base}/${encodeURIComponent(policy.id)}`, { method: "DELETE" });
      toast.success(`Detached ${policy.name}.`);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <div className="space-y-3 border-t border-border pt-3">
    <p className="text-xs font-medium">Identity policies ({state.items.length}/10) — explicit Deny beats Allow; otherwise implicit deny</p>
    {state.status === "loading" ? <div className="flex justify-center py-4"><LogoLoading /></div> : null}
    {state.status === "error" ? <p className="text-xs text-destructive">{state.error} <Button variant="outline" size="sm" onClick={refresh}>Retry</Button></p> : null}
    {state.status === "ready" && state.items.length > 0 ? <ul className="space-y-2">
      {state.items.map((policy) => <li key={policy.id} className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">{policy.name}</span>
        <code className="text-muted-foreground">{(policy.document?.Statement ?? []).length} statement(s)</code>
        {writable ? <Button variant="outline" size="sm" disabled={busy} onClick={() => remove(policy)}>Detach</Button> : null}
      </li>)}
    </ul> : null}
    {state.status === "ready" && state.items.length === 0 ? <p className="text-xs text-muted-foreground">No policies — this credential is implicitly denied everywhere until one allows it.</p> : null}
    {writable ? <div className="grid gap-2">
      <div className="flex gap-2">
        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Policy name" aria-label="Policy name" />
        <Button variant="outline" size="sm" disabled={busy} onClick={attach}>Attach policy</Button>
      </div>
      <Textarea rows={6} value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} className="font-mono text-xs" aria-label="Policy document (JSON)" />
    </div> : null}
  </div>;
}

export function SigningCredentialsScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [busy, setBusy] = useState(false);
  const writable = can("pods.secret.write");

  const refresh = useCallback(async () => {
    setState({ status: "loading", items: [], error: null });
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

  if (!can("pods.secrets.view") && !writable) {
    return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
      <ScreenHeader title="Signing credentials" description="SigV4 credentials for signed API requests." />
      <SectionCard><EmptyState icon={LockKeyhole} title="Access unavailable" description="Your current team access does not allow this screen." /></SectionCard>
    </div>;
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

  const remove = async (credential) => {
    setBusy(true);
    try {
      await api(project.id, `/${encodeURIComponent(credential.id)}`, { method: "DELETE" });
      toast.success(`Deleted ${credential.name}.`);
      if (expanded === credential.id) setExpanded(null);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
    <ScreenHeader
      title="Signing credentials"
      description="IAM-equivalent access keys. Standard AWS SDK signers sign Pods requests with these credentials; the gateway region is auto."
      actions={writable ? <Button onClick={() => { setCreated(null); setCreating(true); }}><Plus className="size-4" />New credential</Button> : null}
    />
    {created ? <OnceSecret created={created} /> : null}
    {state.status === "loading" ? <SectionCard><div className="flex justify-center py-10"><LogoLoading /></div></SectionCard> : null}
    {state.status === "error" ? <SectionCard><EmptyState icon={KeyRound} title="Credentials unavailable" description={state.error} action={<Button variant="outline" onClick={refresh}>Retry</Button>} /></SectionCard> : null}
    {state.status === "ready" && state.items.length === 0 ? <SectionCard><EmptyState icon={KeyRound} title="No signing credentials" description="Create one, copy the secret once, and sign requests with any AWS SigV4 signer." action={writable ? <Button onClick={() => setCreating(true)}>New credential</Button> : undefined} /></SectionCard> : null}
    {state.status === "ready" && state.items.length > 0 ? <div className="space-y-4">
      {state.items.map((credential) => <SectionCard key={credential.id} title={credential.name} description={`Principal arn:pods:iam::${project.id}:credential/${credential.accessKeyId}`}>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <code className="font-mono">{credential.accessKeyId}</code>
          <Badge variant={credential.status === "ACTIVE" ? "outline" : "secondary"}>{credential.status}</Badge>
          <span>{credential.lastUsedAt ? `Last used ${new Date(credential.lastUsedAt).toLocaleString()}` : "Never used"}</span>
          {credential.expiresAt ? <span>Expires {new Date(credential.expiresAt).toLocaleDateString()}</span> : null}
          <span className="flex-1" />
          <Button variant="outline" size="sm" onClick={() => setExpanded(expanded === credential.id ? null : credential.id)}>Policies</Button>
          {writable ? <Button variant="outline" size="sm" disabled={busy} onClick={() => flip(credential)}>{credential.status === "ACTIVE" ? "Deactivate" : "Activate"}</Button> : null}
          {writable ? <Button variant="outline" size="sm" disabled={busy} onClick={() => remove(credential)}>Delete</Button> : null}
        </div>
        {expanded === credential.id ? <div className="pt-2"><Policies credential={credential} /></div> : null}
      </SectionCard>)}
    </div> : null}
    <Dialog open={creating} onOpenChange={setCreating}>
      <DialogContent>
        <DialogHeader><DialogTitle>New signing credential</DialogTitle><DialogDescription>The secret access key is shown once. Access key ids start with PKIA.</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const name = String(form.get("name") ?? "").trim();
          const expiresAt = String(form.get("expiresAt") ?? "").trim();
          if (!name) {
            toast.error("Name is required.");
            return;
          }
          setBusy(true);
          api(project.id, "", { method: "POST", body: JSON.stringify({ name, ...(expiresAt ? { expiresAt } : {}) }) }).then(
            (result) => {
              setCreated(result.body ?? result);
              setCreating(false);
              void refresh();
              toast.success("Credential created — copy the secret now.");
            },
            (error) => toast.error(error.message),
          ).finally(() => setBusy(false));
        }}>
          <div className="space-y-2">
            <Label htmlFor="cred-name">Name</Label>
            <Input id="cred-name" name="name" placeholder="deploy-bot" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="cred-expiry">Expires at (optional)</Label>
            <Input id="cred-expiry" name="expiresAt" type="date" />
          </div>
          <DialogFooter><Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create credential"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>;
}
