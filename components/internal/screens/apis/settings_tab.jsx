"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Settings2, Trash2 } from "lucide-react";
import { EmptyState, SectionCard } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { fetchApis } from "./api_list";

export function SettingsTab({ api }) {
  const { project } = useProject();
  const router = useRouter();
  const { can } = useRbac();
  const writable = can("pods.api.update");
  const deletable = can("pods.api.delete");
  const rest = api.protocol === "REST";
  const [form, setForm] = useState({
    name: api.name,
    description: api.description ?? "",
    apiVersion: api.apiVersion ?? "",
    endpointType: api.endpointType ?? "REGIONAL",
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
      toast.success(`Deleted ${api.name}.`);
      router.push(`/project/${encodeURIComponent(project.id)}/apis`);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  if (!writable && !deletable) {
    return <SectionCard><EmptyState icon={Settings2} title="Access unavailable" description="Your current team access does not allow editing this API." /></SectionCard>;
  }

  return <div className="space-y-8">
    {writable ? <SectionCard title="General" description="Protocol is immutable; create a new API to change it.">
      <form className="space-y-4" onSubmit={save}>
        <div className="space-y-2">
          <Label htmlFor="settings-name">Name</Label>
          <Input id="settings-name" value={form.name} onChange={set("name")} maxLength={128} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="settings-description">Description</Label>
          <Textarea id="settings-description" value={form.description} onChange={set("description")} rows={2} maxLength={1024} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="settings-version">Version label</Label>
            <Input id="settings-version" value={form.apiVersion} onChange={set("apiVersion")} placeholder="v1" maxLength={64} />
          </div>
          <div className="space-y-2">
            <Label>Endpoint type</Label>
            <Select value={form.endpointType} onValueChange={set("endpointType")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="REGIONAL">REGIONAL</SelectItem>
                <SelectItem value="EDGE" disabled={!rest}>EDGE (REST only)</SelectItem>
                <SelectItem value="PRIVATE" disabled={!rest}>PRIVATE (REST only)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {rest ? <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>API key source</Label>
            <Select value={form.apiKeySource} onValueChange={set("apiKeySource")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="HEADER">HEADER</SelectItem>
                <SelectItem value="AUTHORIZER">AUTHORIZER</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Missing route behavior</Label>
            <Select value={form.missingRouteBehavior} onValueChange={set("missingRouteBehavior")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="aws">403 Missing Authentication Token (AWS)</SelectItem>
                <SelectItem value="not_found">404 Not Found</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="settings-binary">Binary media types (one per line)</Label>
            <Textarea id="settings-binary" value={form.binaryMediaTypes} onChange={set("binaryMediaTypes")} rows={3} placeholder={"image/png\n*/*"} className="font-mono" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="settings-compression">Minimum compression size (bytes, empty = off)</Label>
            <Input id="settings-compression" value={form.minimumCompressionSize} onChange={set("minimumCompressionSize")} inputMode="numeric" placeholder="0–10485760" />
          </div>
        </div> : null}
        <div><Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save settings"}</Button></div>
      </form>
    </SectionCard> : null}
    {deletable ? <SectionCard title="Danger" description="Deleting an API hides its draft and every child row.">
      <Button variant="outline" size="sm" onClick={() => { setConfirmName(""); setConfirming(true); }}><Trash2 className="size-4" />Delete API</Button>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {api.name}?</DialogTitle>
            <DialogDescription>Type the API name to confirm. This cannot be undone.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="delete-confirm">API name</Label>
            <Input id="delete-confirm" value={confirmName} onChange={(event) => setConfirmName(event.target.value)} placeholder={api.name} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="destructive" disabled={busy || confirmName !== api.name} onClick={remove}>
              {busy ? "Deleting…" : "Delete API"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard> : null}
  </div>;
}
