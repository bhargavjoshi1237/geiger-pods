"use client";

// Resource policy editor (S07 §8, REST API settings): JSON editor with the
// four spec templates (mirroring `POLICY_TEMPLATES` in
// `lib/control/resource-policies.mjs`) and a policy simulator calling
// `resource-policy/simulate`. Edits take effect on the next deployment.

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { EmptyState, SectionCard } from "@geiger/ui/screen-kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { fetchApis } from "../apis/api_list";
import { validatePolicyJson } from "@/lib/workspace/auth-ui.mjs";

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
    return <SectionCard><div className="flex justify-center py-6"><LogoLoading /></div></SectionCard>;
  }
  if (state.status === "error") {
    return <SectionCard><EmptyState icon={ShieldCheck} title="Resource policy unavailable" description={state.error} /></SectionCard>;
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
    }
  };

  return <div className="space-y-8">
    <SectionCard title="Resource policy" description="IP, connector and principal rules evaluated before authorizers (explicit Deny first). Changes take effect on the next deployment.">
      <div className="flex flex-wrap gap-2 pb-3">
        {Object.entries(TEMPLATES).map(([key, template]) => <Button
          key={key}
          variant="outline"
          size="sm"
          disabled={!writable || busy}
          title={template.description}
          onClick={() => setText(JSON.stringify(template.document, null, 2))}
        >{template.title}</Button>)}
      </div>
      <div className="space-y-2">
        <Label htmlFor="resource-policy-doc">Policy document (JSON, ≤ 8192 chars serialized)</Label>
        <Textarea id="resource-policy-doc" rows={12} value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} disabled={!writable || busy} className="font-mono text-xs" />
      </div>
      {writable ? <div className="flex gap-2 pt-3">
        <Button size="sm" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save policy"}</Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={clear}>Clear</Button>
      </div> : <p className="pt-3 text-xs text-muted-foreground">Read-only: editing needs the resource-policy permission.</p>}
    </SectionCard>
    <SectionCard title="Policy simulator" description="Evaluate a method ARN, source IP and optional principal against the saved draft policy.">
      <div className="grid gap-3">
        <div className="space-y-2">
          <Label htmlFor="simulate-arn">Method ARN</Label>
          <Input id="simulate-arn" value={methodArn} onChange={(event) => setMethodArn(event.target.value)} placeholder={`arn:pods:execute-api:auto:${project.id}:…/prod/GET/pets`} spellCheck={false} className="font-mono text-xs" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="simulate-ip">Source IP</Label>
            <Input id="simulate-ip" value={sourceIp} onChange={(event) => setSourceIp(event.target.value)} placeholder="203.0.113.7" spellCheck={false} className="font-mono text-xs" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="simulate-principal">Principal ARN (optional)</Label>
            <Input id="simulate-principal" value={principalArn} onChange={(event) => setPrincipalArn(event.target.value)} placeholder="arn:pods:iam::…:credential/PKIA…" spellCheck={false} className="font-mono text-xs" />
          </div>
        </div>
        <div><Button variant="outline" size="sm" disabled={busy || !writable} onClick={simulate}>{busy ? "Simulating…" : "Simulate"}</Button></div>
        {simulation ? <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant={simulation.decision === "Allow" ? "outline" : "destructive"}>{simulation.decision}</Badge>
          {(simulation.matched ?? []).map((entry, index) => <code key={index} className="font-mono">{entry.effect} #{entry.index}</code>)}
          {simulation.note ? <span className="text-muted-foreground">{simulation.note}</span> : null}
        </div> : null}
      </div>
    </SectionCard>
  </div>;
}
