"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Settings2, Trash2 } from "lucide-react";
import { EmptyState, Field, SectionCard } from "@/components/internal/shared/screen_kit";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { Switch } from "@geiger/ui/switch";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { useWorkspaceNav } from "@/context/workspace-nav-context";
import { fetchApis } from "./api_list";
import { ClientCertificatesCard } from "../integrations/client_certificates";
import { ResourcePolicyEditor } from "../auth/resource_policy_editor";
import { TagsEditor } from "../admin/tags_editor";

export function SettingsTab({ api }) {
  const { project } = useProject();
  const router = useRouter();
  const { can } = useRbac();
  const { navigate } = useWorkspaceNav();
  const writable = can("pods.api.update");
  const deletable = can("pods.api.delete");
  const rest = api.protocol === "REST";
  const [form, setForm] = useState({
    name: api.name,
    description: api.description ?? "",
    apiVersion: api.apiVersion ?? "",
    endpointType: api.endpointType ?? "REGIONAL",
    ipAddressType: api.ipAddressType ?? "ipv4",
    disableDefaultEndpoint: api.disableDefaultEndpoint ?? false,
    apiKeySource: api.apiKeySource ?? "HEADER",
    binaryMediaTypes: (api.binaryMediaTypes ?? []).join("\n"),
    minimumCompressionSize: api.minimumCompressionSize ?? "",
    missingRouteBehavior: api.missingRouteBehavior ?? "aws",
  });
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmName, setConfirmName] = useState("");

  const set = (key) => (eventOrValue) => {
    const value = typeof eventOrValue === "string" ? eventOrValue : eventOrValue.target.value;
    setForm((current) => ({ ...current, [key]: value }));
  };

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const body = {
        name: form.name.trim(),
        description: form.description,
        apiVersion: form.apiVersion.trim() || null,
        endpointType: form.endpointType,
        ipAddressType: form.ipAddressType,
        disableDefaultEndpoint: form.disableDefaultEndpoint,
      };
      if (rest) {
        body.apiKeySource = form.apiKeySource;
        body.binaryMediaTypes = form.binaryMediaTypes.split("\n").map((line) => line.trim()).filter(Boolean);
        body.minimumCompressionSize = form.minimumCompressionSize === "" ? null : Number(form.minimumCompressionSize);
        body.missingRouteBehavior = form.missingRouteBehavior;
      }
      await fetch(`/api/v1/projects/${encodeURIComponent(project.id)}/apis/${encodeURIComponent(api.publicId ?? api.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "if-match": String(api.version) },
        body: JSON.stringify(body),
      }).then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
        return data;
      });
      toast.success("Saved API settings.");
      router.refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await fetchApis(project.id, `/${encodeURIComponent(api.publicId ?? api.id)}`, { method: "DELETE" });
      toast.success(`Deleted "${api.name}".`);
      navigate("apis");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  if (!writable && !deletable) {
    return <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={Settings2} title="Access unavailable" description="Your current team access does not allow editing this API." /></div>;
  }

  return <div className="space-y-8">
    {writable ? <form className="space-y-8" onSubmit={save}>
      <SectionCard bare title="General" description="The protocol is fixed once an API exists; create a new API to change it.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="settings-name">
            <Input id="settings-name" value={form.name} onChange={set("name")} maxLength={128} required />
          </Field>
          <Field label="Version label" htmlFor="settings-version">
            <Input id="settings-version" value={form.apiVersion} onChange={set("apiVersion")} placeholder="v1" maxLength={64} />
          </Field>
          <Field label="Description" htmlFor="settings-description" className="sm:col-span-2">
            <Textarea id="settings-description" value={form.description} onChange={set("description")} rows={2} maxLength={1024} />
          </Field>
        </div>
      </SectionCard>

      <SectionCard bare title="Endpoint" description="How clients reach this API.">
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Endpoint type" htmlFor="settings-endpoint-type">
              <Select value={form.endpointType} onValueChange={set("endpointType")}>
                <SelectTrigger id="settings-endpoint-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="REGIONAL">REGIONAL</SelectItem>
                  <SelectItem value="EDGE" disabled={!rest}>EDGE (REST only)</SelectItem>
                  <SelectItem value="PRIVATE" disabled={!rest}>PRIVATE (REST only)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="IP address type" htmlFor="settings-ip-type">
              <Select value={form.ipAddressType} onValueChange={set("ipAddressType")}>
                <SelectTrigger id="settings-ip-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ipv4">IPv4 only</SelectItem>
                  <SelectItem value="dualstack">Dual-stack (IPv4 + IPv6)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <label htmlFor="settings-disable-default-endpoint" className="flex items-center justify-between gap-4 rounded-xl border border-border bg-surface-card p-4">
            <span>
              <span className="block text-sm font-medium text-foreground">Disable default endpoint</span>
              <span className="mt-0.5 block text-xs text-text-secondary">Takes effect on the next deployment. Required for mTLS; custom domains keep serving.</span>
            </span>
            <Switch
              id="settings-disable-default-endpoint"
              checked={form.disableDefaultEndpoint}
              onCheckedChange={(checked) => setForm((current) => ({ ...current, disableDefaultEndpoint: checked === true }))}
            />
          </label>
          {form.endpointType === "PRIVATE" && rest ? <p className="rounded-xl border border-border bg-surface-subtle px-4 py-3 text-xs text-text-secondary">
            Private APIs are reachable only through a Pods Connector in ingress mode and must attach a resource
            policy allowing an aws:SourceVpce / aws:SourceVpc — use the resource policy below.
          </p> : null}
        </div>
      </SectionCard>

      {rest ? <SectionCard bare title="Request handling" description="API keys, unmatched routes, binary payloads and compression.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="API key source" htmlFor="settings-api-key-source">
            <Select value={form.apiKeySource} onValueChange={set("apiKeySource")}>
              <SelectTrigger id="settings-api-key-source"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="HEADER">HEADER</SelectItem>
                <SelectItem value="AUTHORIZER">AUTHORIZER</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Missing route behavior" htmlFor="settings-missing-route">
            <Select value={form.missingRouteBehavior} onValueChange={set("missingRouteBehavior")}>
              <SelectTrigger id="settings-missing-route"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="aws">403 Missing Authentication Token (AWS)</SelectItem>
                <SelectItem value="not_found">404 Not Found</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Binary media types" htmlFor="settings-binary" hint="One per line.">
            <Textarea id="settings-binary" value={form.binaryMediaTypes} onChange={set("binaryMediaTypes")} rows={3} placeholder={"image/png\n*/*"} className="font-mono" />
          </Field>
          <Field label="Minimum compression size" htmlFor="settings-compression" hint="In bytes. Leave empty to turn compression off.">
            <Input id="settings-compression" value={form.minimumCompressionSize} onChange={set("minimumCompressionSize")} inputMode="numeric" placeholder="0–10485760" />
          </Field>
        </div>
      </SectionCard> : null}

      <div className="flex justify-end">
        <Button type="submit" className="bg-primary text-primary-foreground hover:bg-primary/90" disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}{busy ? "Saving…" : "Save Changes"}
        </Button>
      </div>
    </form> : null}

    {rest ? <ResourcePolicyEditor api={api} /> : null}
    <TagsEditor resourceType="api" resourceId={api.id} />
    <ClientCertificatesCard />

    {deletable ? <SectionCard bare title="Danger zone">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-red-500/20 bg-red-500/5 p-5">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Delete this API</p>
          <p className="mt-0.5 text-xs text-text-secondary">Removes the draft and everything defined under it. This can&apos;t be undone.</p>
        </div>
        <Button
          variant="outline"
          className="shrink-0 border-red-500/30 bg-transparent text-red-700 hover:bg-red-500/10 hover:text-red-700 dark:text-red-300 dark:hover:text-red-300"
          onClick={() => { setConfirmName(""); setConfirming(true); }}
        ><Trash2 className="size-4" />Delete API</Button>
      </div>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="bg-background sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete API</DialogTitle>
            <DialogDescription>
              Delete <span className="font-medium text-foreground">{api.name}</span>? Type the API name to confirm. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <Field label="API name" htmlFor="delete-confirm">
            <Input id="delete-confirm" value={confirmName} onChange={(event) => setConfirmName(event.target.value)} placeholder={api.name} />
          </Field>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button className="bg-red-500/90 text-white hover:bg-red-500" disabled={busy || confirmName !== api.name} onClick={remove}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard> : null}
  </div>;
}
