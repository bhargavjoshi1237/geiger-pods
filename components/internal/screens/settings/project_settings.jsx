"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderKanban, Gauge, Globe2, Loader2, LockKeyhole, ScrollText, Settings2 } from "lucide-react";
import { EmptyState, Field, LoadingArea, ScreenHeader, SectionCard, SettingRow, SettingsList } from "@/components/internal/shared/screen_kit";
import { MainScreenWrapper } from "@/components/internal/shared/screen_wrappers";
import { EditorSections } from "@/components/internal/shared/editor_shell";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
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
  { key: "throttleRate", label: "Throttle rate", hint: "Steady-state requests per second across the project.", type: "number" },
  { key: "throttleBurst", label: "Throttle burst", hint: "Requests allowed above the rate in a short spike.", type: "number" },
  { key: "logRetentionDays", label: "Log retention (days)", hint: "How long access and execution logs are kept.", type: "number" },
  { key: "dataTraceRetentionDays", label: "Full-payload trace retention (days)", hint: "Request and response bodies are kept for a shorter window.", type: "number" },
  { key: "defaultRegion", label: "Default region", hint: "Where new stages run unless they say otherwise.", type: "text" },
];

const fieldByKey = Object.fromEntries(FIELDS.map((field) => [field.key, field]));

function toForm(settings) {
  const form = { throttleKvFailure: settings?.throttleKvFailure ?? "open" };
  for (const field of FIELDS) form[field.key] = settings?.[field.key] === undefined || settings?.[field.key] === null ? "" : String(settings[field.key]);
  return form;
}

function GatewayUnavailable({ error, onRetry }) {
  return <div className="rounded-xl border border-border bg-surface-subtle">
    <EmptyState icon={Settings2} title="Settings unavailable" description={error ?? "Try again shortly."} action={<Button variant="outline" onClick={onRetry}>Retry</Button>} />
  </div>;
}

function FieldInput({ fieldKey, form, set, disabled }) {
  const field = fieldByKey[fieldKey];
  return <Field label={field.label} htmlFor={`settings-${field.key}`} hint={field.hint}>
    <Input
      id={`settings-${field.key}`}
      type={field.type}
      value={form[field.key]}
      onChange={(event) => set({ [field.key]: event.target.value })}
      disabled={disabled}
    />
  </Field>;
}

function ProjectSection() {
  return <ProjectDetails />;
}

function ThrottlingSection({ form, set, disabled, settings, error, onRetry }) {
  if (!settings) return <GatewayUnavailable error={error} onRetry={onRetry} />;
  return <div className="space-y-6">
    <SectionCard title="Account throttle" description="The ceiling every stage and usage plan sits under.">
      <div className="grid gap-4 sm:grid-cols-2">
        <FieldInput fieldKey="throttleRate" form={form} set={set} disabled={disabled} />
        <FieldInput fieldKey="throttleBurst" form={form} set={set} disabled={disabled} />
      </div>
    </SectionCard>
    <SectionCard title="Limit store outage" description="What the gateway does if it can't reach the store that counts requests.">
      <SettingsList>
        <SettingRow
          icon={Gauge}
          title="Throttle behavior when the limit store is down"
          description="Fail open keeps traffic flowing unthrottled; fail closed rejects requests until the store is back."
          control={<Select value={form.throttleKvFailure} onValueChange={(value) => set({ throttleKvFailure: value })} disabled={disabled}>
            <SelectTrigger id="settings-throttleKvFailure" className="w-52" aria-label="Throttle behavior when the limit store is down"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="open">Fail open (allow traffic)</SelectItem>
              <SelectItem value="closed">Fail closed (reject traffic)</SelectItem>
            </SelectContent>
          </Select>}
        />
      </SettingsList>
    </SectionCard>
  </div>;
}

function RetentionSection({ form, set, disabled, settings, error, onRetry }) {
  if (!settings) return <GatewayUnavailable error={error} onRetry={onRetry} />;
  return <SectionCard title="Log retention" description="Older entries are deleted automatically.">
    <div className="grid gap-4 sm:grid-cols-2">
      <FieldInput fieldKey="logRetentionDays" form={form} set={set} disabled={disabled} />
      <FieldInput fieldKey="dataTraceRetentionDays" form={form} set={set} disabled={disabled} />
    </div>
  </SectionCard>;
}

function RoutingSection({ form, set, disabled, settings, error, onRetry }) {
  if (!settings) return <GatewayUnavailable error={error} onRetry={onRetry} />;
  return <SectionCard title="Routing defaults" description="Applied when a stage doesn't set its own.">
    <div className="grid gap-4 sm:grid-cols-2">
      <FieldInput fieldKey="defaultRegion" form={form} set={set} disabled={disabled} />
    </div>
  </SectionCard>;
}

const SECTIONS = [
  { key: "project", label: "Project", icon: FolderKanban, desc: "The shared Geiger project behind this workspace.", render: ProjectSection },
  { key: "throttling", label: "Throttling", icon: Gauge, desc: "Project-wide request limits and how they behave under failure.", render: ThrottlingSection },
  { key: "retention", label: "Logs & Retention", icon: ScrollText, desc: "How long gateway logs and payload traces are kept.", render: RetentionSection },
  { key: "routing", label: "Routing", icon: Globe2, desc: "Defaults for where new stages run.", render: RoutingSection },
];

export function SettingsScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", settings: null, error: null });
  const [form, setForm] = useState(() => toForm(null));
  const [saving, setSaving] = useState(false);
  const writable = can("pods.settings.write");

  const load = useCallback(async () => {
    setState({ status: "loading", settings: null, error: null });
    try {
      const settings = await api(project.id, "");
      setState({ status: "ready", settings, error: null });
      setForm(toForm(settings));
    } catch (error) {
      setState({ status: "ready", settings: null, error: error.message });
    }
  }, [project.id]);

  useEffect(() => {
    let alive = true;
    api(project.id, "")
      .then((settings) => {
        if (!alive) return;
        setState({ status: "ready", settings, error: null });
        setForm(toForm(settings));
      })
      .catch((error) => { if (alive) setState({ status: "ready", settings: null, error: error.message }); });
    return () => { alive = false; };
  }, [project.id]);

  const set = useCallback((patch) => setForm((current) => ({ ...current, ...patch })), []);

  const save = async () => {
    const patch = {};
    for (const field of FIELDS) {
      const raw = String(form[field.key] ?? "").trim();
      if (raw) patch[field.key] = field.type === "number" ? Number(raw) : raw;
    }
    patch.throttleKvFailure = form.throttleKvFailure ?? state.settings?.throttleKvFailure ?? "open";
    setSaving(true);
    try {
      const saved = await api(project.id, "", {
        method: "PATCH",
        headers: { "If-Match": String(state.settings?.version ?? 0) },
        body: JSON.stringify(patch),
      });
      setState({ status: "ready", settings: saved, error: null });
      setForm(toForm(saved));
      toast.success("Settings saved.");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const sectionProps = useMemo(() => ({
    form,
    set,
    disabled: !writable || saving,
    settings: state.settings,
    error: state.error,
    onRetry: load,
  }), [form, set, writable, saving, state.settings, state.error, load]);

  const loading = state.status === "loading";

  return <MainScreenWrapper>
    <ScreenHeader
      title="General"
      description="Project details and gateway defaults for this workspace."
      actions={writable ? <Button
        className="bg-primary text-primary-foreground hover:bg-primary/90"
        disabled={saving || loading || !state.settings}
        onClick={save}
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {saving ? "Saving…" : "Save Changes"}
      </Button> : null}
    />

    {!writable ? <div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface-card px-3.5 py-2.5 text-xs leading-relaxed text-text-secondary">
      <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-tertiary" />
      <p>You can see these settings, but changing them needs the <span className="text-foreground">Edit project settings</span> permission.</p>
    </div> : null}

    {loading ? <LoadingArea panel label="Loading settings" /> : <EditorSections nav={SECTIONS} defaultSection="project">
      {({ activeItem }) => {
        // Rendered as an element, not called — sections own their own hooks.
        const Body = activeItem.render;
        return <Body {...sectionProps} />;
      }}
    </EditorSections>}
  </MainScreenWrapper>;
}
