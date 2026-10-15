"use client";

// Resource policy editor (REST API settings): JSON editor with four starter
// templates (mirroring `POLICY_TEMPLATES` in
// `lib/control/resource-policies.mjs`) and a policy simulator calling
// `resource-policy/simulate`. Edits take effect on the next deployment.

import { useEffect, useState } from "react";
import { Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { EmptyState, Field, LoadingArea, SectionCard } from "@/components/internal/shared/screen_kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { fetchApis } from "../apis/api_list";
import { validatePolicyJson } from "@/lib/workspace/auth-ui.mjs";

const PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";
const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

const TEMPLATES = {
  ipAllowList: {
    title: "IP allow-list",
    description: "Allow invoke from two office ranges; everything else is implicitly denied.",
    document: {
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Action: "execute-api:Invoke",
        Resource: "arn:pods:execute-api:*",
        Condition: { IpAddress: { "aws:SourceIp": ["203.0.113.0/24", "198.51.100.0/24"] } },
      }],
    },
  },
  denyIpRange: {
    title: "Deny IP range",
    description: "Explicitly deny one abusive range; all other callers fall through to the authorizer.",
    document: {
      Version: "2012-10-17",
      Statement: [{
        Effect: "Deny",
        Action: "execute-api:Invoke",
        Resource: "arn:pods:execute-api:*",
        Condition: { IpAddress: { "aws:SourceIp": "192.0.2.0/24" } },
      }],
    },
  },
  connectorOnly: {
    title: "Connector-only private API",
    description: "Allow invoke only through one private connector (source VPC endpoint).",
    document: {
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Action: "execute-api:Invoke",
        Resource: "arn:pods:execute-api:*",
        Condition: { StringEquals: { "aws:SourceVpce": "CONNECTOR_ID" } },
      }],
    },
  },
  crossProjectAllow: {
    title: "Cross-project principal allow",
    description: "Allow one foreign signing credential to invoke this API.",
    document: {
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Action: "execute-api:Invoke",
        Resource: "arn:pods:execute-api:*",
        Principal: { Pods: ["arn:pods:iam::OTHER_PROJECT:credential/PKIAXXXXXXXXXXXXXXXX"] },
      }],
    },
  },
};

export function ResourcePolicyEditor({ api }) {
  const { project } = useProject();
  const { can } = useRbac();
  const apiRef = api.publicId ?? api.id;
  const [state, setState] = useState({ status: "loading", document: null, error: null });
  const [text, setText] = useState("");
  const [version, setVersion] = useState(api.version);
  const [methodArn, setMethodArn] = useState("");
  const [sourceIp, setSourceIp] = useState("");
  const [principalArn, setPrincipalArn] = useState("");
  const [simulation, setSimulation] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const writable = can("pods.resource_policy.write");

  useEffect(() => {
    let alive = true;
    fetchApis(project.id, `/${encodeURIComponent(apiRef)}/resource-policy`).then(
      (data) => {
        if (!alive) return;
        setState({ status: "ready", document: data.document ?? null, error: null });
        setText(JSON.stringify(data.document ?? { Version: "2012-10-17", Statement: [] }, null, 2));
      },
      (error) => { if (alive) setState({ status: "error", document: null, error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id, apiRef]);

  if (api.protocol !== "REST") return null;

  if (state.status === "loading") {
    return <LoadingArea label="Loading resource policy" />;
  }
  if (state.status === "error") {
    return <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={ShieldCheck} title="Resource policy unavailable" description={state.error} /></div>;
  }

  const save = async () => {
    let document;
    try {
      ({ document } = validatePolicyJson(text));
    } catch (error) {
      toast.error(error.message);
      return;
    }
    setBusy(true);
    setSaving(true);
    try {
      const saved = await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/resource-policy`, {
        method: "PUT",
        headers: { "If-Match": String(version) },
        body: JSON.stringify({ document }),
      });
      setVersion(saved.version ?? version);
      toast.success("Resource policy saved — it takes effect on the next deployment.");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
      setSaving(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      const saved = await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/resource-policy`, {
        method: "PUT",
        headers: { "If-Match": String(version) },
        body: JSON.stringify({ document: null }),
      });
      setVersion(saved.version ?? version);
      setText(JSON.stringify({ Version: "2012-10-17", Statement: [] }, null, 2));
      toast.success("Resource policy cleared — takes effect on the next deployment.");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const simulate = async () => {
    if (!methodArn.trim()) {
      toast.error("A method ARN is required to simulate.");
      return;
    }
    setBusy(true);
    setSimulating(true);
    try {
      const result = await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/resource-policy/simulate`, {
        method: "POST",
        body: JSON.stringify({
          methodArn: methodArn.trim(),
          sourceIp: sourceIp.trim(),
          ...(principalArn.trim() ? { principalArn: principalArn.trim() } : {}),
        }),
      });
      setSimulation(result);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
      setSimulating(false);
    }
  };

  return <div className="space-y-8">
    <SectionCard
      bare
      title="Resource policy"
      description="IP, connector and principal rules evaluated before authorizers (explicit Deny first). Changes take effect on the next deployment."
      action={writable ? <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" size="sm" className={SECONDARY} disabled={busy} onClick={() => setConfirmClear(true)}>Clear</Button>
        <Button size="sm" className={PRIMARY} disabled={busy} onClick={save}>{saving ? "Saving…" : "Save Policy"}</Button>
      </div> : null}
    >
      <div className="space-y-4">
        <Field label="Start from a template">
          <div className="flex flex-wrap gap-2">
            {Object.entries(TEMPLATES).map(([key, template]) => <Button
              key={key}
              variant="outline"
              size="sm"
              className={SECONDARY}
              disabled={!writable || busy}
              title={template.description}
              onClick={() => setText(JSON.stringify(template.document, null, 2))}
            >{template.title}</Button>)}
          </div>
        </Field>
        <Field label="Policy document" htmlFor="resource-policy-doc" hint="JSON, up to 8192 characters serialized.">
          <Textarea id="resource-policy-doc" rows={12} value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} disabled={!writable || busy} className="font-mono text-xs" />
        </Field>
        {writable ? null : <p className="text-xs text-text-secondary">Read-only: editing needs the resource-policy permission.</p>}
      </div>
    </SectionCard>
    <SectionCard bare title="Policy simulator" description="Evaluate a method ARN, source IP and optional principal against the saved draft policy.">
      <div className="grid gap-4">
        <Field label="Method ARN" htmlFor="simulate-arn">
          <Input id="simulate-arn" value={methodArn} onChange={(event) => setMethodArn(event.target.value)} placeholder={`arn:pods:execute-api:auto:${project.id}:…/prod/GET/pets`} spellCheck={false} className="font-mono text-xs" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Source IP" htmlFor="simulate-ip">
            <Input id="simulate-ip" value={sourceIp} onChange={(event) => setSourceIp(event.target.value)} placeholder="203.0.113.7" spellCheck={false} className="font-mono text-xs" />
          </Field>
          <Field label="Principal ARN" htmlFor="simulate-principal" hint="Optional.">
            <Input id="simulate-principal" value={principalArn} onChange={(event) => setPrincipalArn(event.target.value)} placeholder="arn:pods:iam::…:credential/PKIA…" spellCheck={false} className="font-mono text-xs" />
          </Field>
        </div>
        <div><Button variant="outline" size="sm" className={SECONDARY} disabled={busy || !writable} onClick={simulate}>{simulating ? <Loader2 className="size-4 animate-spin" /> : null}Simulate</Button></div>
        {simulation ? <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant={simulation.decision === "Allow" ? "outline" : "destructive"}>{simulation.decision}</Badge>
          {(simulation.matched ?? []).map((entry, index) => <code key={index} className="font-mono">{entry.effect} #{entry.index}</code>)}
          {simulation.note ? <span className="text-text-secondary">{simulation.note}</span> : null}
        </div> : null}
      </div>
    </SectionCard>
    <Dialog open={confirmClear} onOpenChange={(open) => { if (!open) setConfirmClear(false); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Clear resource policy</DialogTitle>
          <DialogDescription>Are you sure you want to remove the resource policy? From the next deployment, callers are no longer filtered by IP, connector or principal.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setConfirmClear(false)}>Cancel</Button>
          <Button className="bg-red-500/90 text-white hover:bg-red-500" disabled={busy} onClick={() => { setConfirmClear(false); clear(); }}><Trash2 className="size-4" />Clear</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
