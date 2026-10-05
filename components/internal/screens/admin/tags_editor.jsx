"use client";

// Tag editor (S14 §5): key→value table with AWS key rules, reserved-prefix
// rejection, and the 50-tag cap. Standalone: the orchestrator mounts it on
// resource detail views.

import { useEffect, useState } from "react";
import { Plus, Tags, Trash2 } from "lucide-react";
import { EmptyState, SectionCard } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";

export function TagsEditor({ resourceType, resourceId }) {
  const { project } = useProject();
  const [state, setState] = useState({ status: "loading", tags: {}, error: null });
  const [draft, setDraft] = useState({ key: "", value: "" });

  useEffect(() => {
    let alive = true;
    fetch(`/api/v1/projects/${encodeURIComponent(project.id)}/tags/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`)
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
        if (alive) setState({ status: "ready", tags: data ?? {}, error: null });
      })
      .catch((error) => { if (alive) setState({ status: "error", tags: {}, error: error.message }); });
    return () => { alive = false; };
  }, [project.id, resourceType, resourceId]);

  const save = async (next) => {
    const response = await fetch(`/api/v1/projects/${encodeURIComponent(project.id)}/tags/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags: next }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
    setState({ status: "ready", tags: data ?? {}, error: null });
  };

  if (state.status === "loading") return <SectionCard><div className="flex justify-center py-6"><LogoLoading /></div></SectionCard>;
  if (state.status === "error") return <SectionCard><EmptyState icon={Tags} title="Tags unavailable" description={state.error} /></SectionCard>;

  const entries = Object.entries(state.tags);
  return <SectionCard title="Tags" description="Organization and usage reports. Keys starting with aws: or pods: are reserved.">
    {entries.length === 0 ? <p className="text-sm text-muted-foreground">No tags yet.</p> : <ul className="mb-4 divide-y divide-border">
      {entries.map(([key, value]) => <li key={key} className="flex items-center gap-2 py-2 first:pt-0 last:pb-0">
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{key} = {value}</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const next = { ...state.tags };
            delete next[key];
            save(next).then(() => toast.success("Tag removed."), (error) => toast.error(error.message));
          }}
        ><Trash2 className="size-4" /></Button>
      </li>)}
    </ul>}
    <form className="flex flex-wrap gap-2" onSubmit={(event) => {
      event.preventDefault();
      if (!draft.key.trim()) return;
      save({ ...state.tags, [draft.key.trim()]: draft.value }).then(
        () => { setDraft({ key: "", value: "" }); toast.success("Tag saved."); },
        (error) => toast.error(error.message),
      );
    }}>
      <Input className="w-40" placeholder="Key" value={draft.key} onChange={(event) => setDraft({ ...draft, key: event.target.value })} />
      <Input className="w-40" placeholder="Value" value={draft.value} onChange={(event) => setDraft({ ...draft, value: event.target.value })} />
      <Button type="submit" variant="outline" size="sm"><Plus className="size-4" />Add</Button>
    </form>
  </SectionCard>;
}
