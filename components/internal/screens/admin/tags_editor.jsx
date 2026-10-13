"use client";

// Tag editor: key→value table with AWS key rules, reserved-prefix rejection
// and the 50-tag cap (all enforced server-side). Standalone: mounted on
// resource detail views.

import { useEffect, useState } from "react";
import { Loader2, Pencil, Plus, Tags, Trash2 } from "lucide-react";
import { DataTable, EmptyState, Field, LoadingArea, SectionCard } from "@/components/internal/shared/screen_kit";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";

const PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";
const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

export function TagsEditor({ resourceType, resourceId }) {
  const { project } = useProject();
  const [state, setState] = useState({ status: "loading", tags: {}, error: null });
  // { mode: "create" | "edit", key, value } while the add/edit dialog is open.
  const [dialog, setDialog] = useState(null);
  const [removeTarget, setRemoveTarget] = useState(null);
  const [busy, setBusy] = useState(false);

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

  const run = async (next, success) => {
    setBusy(true);
    try {
      await save(next);
      toast.success(success);
      return true;
    } catch (error) {
      toast.error(error.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (state.status === "loading") return <LoadingArea panel label="Loading tags" />;
  if (state.status === "error") return <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={Tags} title="Tags unavailable" description={state.error} /></div>;

  const entries = Object.entries(state.tags).map(([key, value]) => ({ key, value }));
  const openCreate = () => setDialog({ mode: "create", key: "", value: "" });

  const submit = async (event) => {
    event.preventDefault();
    const key = dialog.key.trim();
    if (!key) {
      toast.error("Give the tag a key first.");
      return;
    }
    const ok = await run({ ...state.tags, [key]: dialog.value }, "Tag saved.");
    if (ok) setDialog(null);
  };

  const columns = [
    { key: "key", header: "Key", render: (tag) => <span className="font-mono text-sm font-medium text-foreground">{tag.key}</span> },
    { key: "value", header: "Value", render: (tag) => tag.value ? <span className="font-mono text-sm text-text-secondary">{tag.value}</span> : <span className="text-xs text-text-tertiary">Empty</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (tag) => <ActionMenu
        label={`Actions for tag ${tag.key}`}
        disabled={busy}
        items={[
          { icon: Pencil, label: "Edit", onSelect: () => setDialog({ mode: "edit", key: tag.key, value: tag.value }) },
          { separator: true },
          { icon: Trash2, label: "Remove", destructive: true, onSelect: () => setRemoveTarget(tag) },
        ]}
      />,
    },
  ];

  return <SectionCard
    bare
    title="Tags"
    description="Organization and usage reports. Keys starting with aws: or pods: are reserved."
    action={<Button size="sm" className={PRIMARY} onClick={openCreate}><Plus className="size-4" />Add Tag</Button>}
  >
    <DataTable
      columns={columns}
      data={entries}
      getRowKey={(tag) => tag.key}
      onRowClick={(tag) => { if (!busy) setDialog({ mode: "edit", key: tag.key, value: tag.value }); }}
      empty={<button
        type="button"
        onClick={openCreate}
        className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-surface-card py-10 text-text-secondary transition-colors hover:border-border-strong hover:text-muted-foreground"
      >
        <Tags className="size-6" />
        <p className="text-sm">No tags yet — add one to group this resource in usage reports</p>
      </button>}
    />

    <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open) setDialog(null); }}>
      <DialogContent className="bg-background sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{dialog?.mode === "edit" ? "Edit Tag" : "Add Tag"}</DialogTitle>
          <DialogDescription>Tag keys are unique; saving an existing key replaces its value.</DialogDescription>
        </DialogHeader>
        {dialog ? <form className="grid gap-4" onSubmit={submit}>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Key" htmlFor="tag-key">
              <Input id="tag-key" value={dialog.key} onChange={(event) => setDialog({ ...dialog, key: event.target.value })} placeholder="team" disabled={dialog.mode === "edit"} autoFocus={dialog.mode === "create"} spellCheck={false} className="font-mono" />
            </Field>
            <Field label="Value" htmlFor="tag-value">
              <Input id="tag-value" value={dialog.value} onChange={(event) => setDialog({ ...dialog, value: event.target.value })} placeholder="payments" autoFocus={dialog.mode === "edit"} spellCheck={false} className="font-mono" />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" className={SECONDARY} onClick={() => setDialog(null)}>Cancel</Button>
            <Button type="submit" className={PRIMARY} disabled={busy}>{busy ? <Loader2 className="size-4 animate-spin" /> : null}{dialog.mode === "edit" ? "Save Changes" : "Add Tag"}</Button>
          </DialogFooter>
        </form> : null}
      </DialogContent>
    </Dialog>

    <Dialog open={removeTarget !== null} onOpenChange={(open) => { if (!open && !busy) setRemoveTarget(null); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove tag</DialogTitle>
          <DialogDescription>
            Are you sure you want to remove <span className="font-mono font-medium text-foreground">{removeTarget?.key}</span>? Usage reports stop grouping this resource by it.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => setRemoveTarget(null)}>Cancel</Button>
          <Button
            className="bg-red-500/90 text-white hover:bg-red-500"
            disabled={busy}
            onClick={() => {
              const next = { ...state.tags };
              delete next[removeTarget.key];
              void run(next, "Tag removed.").then(() => setRemoveTarget(null));
            }}
          ><Trash2 className="size-4" />Remove</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </SectionCard>;
}
