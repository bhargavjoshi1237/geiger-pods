"use client";

import { useEffect, useState } from "react";
import { LockKeyhole, Settings2 } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { ProjectDetails } from "../project_details";

async function api(projectId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/settings${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

const FIELDS = [
  { key: "throttleRate", label: "Throttle rate (requests/second)", type: "number" },
  { key: "throttleBurst", label: "Throttle burst", type: "number" },
  { key: "logRetentionDays", label: "Log retention (days)", type: "number" },
  { key: "dataTraceRetentionDays", label: "Full-payload trace retention (days)", type: "number" },
  { key: "defaultRegion", label: "Default region", type: "text" },
];

export function SettingsScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", settings: null, error: null });
  const [saving, setSaving] = useState(false);
  const [kvFailure, setKvFailure] = useState(null);
  const writable = can("pods.settings.write");

  useEffect(() => {
    let alive = true;
    api(project.id, "")
      .then((settings) => { if (alive) setState({ status: "ready", settings, error: null }); })
      .catch((error) => { if (alive) setState({ status: "ready", settings: null, error: error.message }); });
    return () => { alive = false; };
  }, [project.id]);

  const save = async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const patch = {};
    for (const field of FIELDS) {
      const raw = String(form.get(field.key) ?? "").trim();
      if (raw) patch[field.key] = field.type === "number" ? Number(raw) : raw;
    }
    patch.throttleKvFailure = kvFailure ?? state.settings?.throttleKvFailure ?? "open";
    setSaving(true);
    try {
      const saved = await api(project.id, "", {
        method: "PATCH",
        headers: { "If-Match": String(state.settings?.version ?? 0) },
        body: JSON.stringify(patch),
      });
      setState({ status: "ready", settings: saved, error: null });
      toast.success("Project settings saved.");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  return <div className="mx-auto w-full max-w-5xl space-y-6 px-2 py-4 lg:px-0">
    <ScreenHeader title="Settings" description="Project details and gateway defaults for this workspace." />
    <ProjectDetails />
    <SectionCard title="Gateway settings" description="Account-level throttling, retention and routing defaults (the AWS account-settings equivalent).">
      {state.status === "loading" ? <div className="flex justify-center py-8"><LogoLoading /></div> : null}
      {state.status === "ready" && !state.settings ? <EmptyState icon={Settings2} title="Settings unavailable" description={state.error ?? "Try again shortly."} /> : null}
      {state.settings ? <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map((field) => <div key={field.key} className="space-y-2">
          <Label htmlFor={`settings-${field.key}`}>{field.label}</Label>
          <Input
            id={`settings-${field.key}`}
            name={field.key}
            type={field.type}
            defaultValue={state.settings[field.key] ?? ""}
            disabled={!writable || saving}
          />
        </div>)}
        <div className="space-y-2">
          <Label>Throttle behavior when the limit store is down</Label>
          <Select
            defaultValue={state.settings.throttleKvFailure}
            onValueChange={setKvFailure}
            disabled={!writable || saving}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="open">Fail open (allow traffic)</SelectItem>
              <SelectItem value="closed">Fail closed (reject traffic)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="sm:col-span-2">
          {writable
            ? <Button type="submit" disabled={saving}>{saving ? "Saving…" : "Save settings"}</Button>
            : <p className="flex items-center gap-2 text-sm text-muted-foreground"><LockKeyhole className="size-4" />Read-only: your team access does not include settings changes.</p>}
        </div>
      </form> : null}
    </SectionCard>
  </div>;
}
