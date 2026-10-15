"use client";

import { useState } from "react";
import { MessageSquareWarning, Pencil, RotateCcw } from "lucide-react";
import { DataTable, EmptyState, Field, LoadingArea, SectionCard } from "@/components/internal/shared/screen_kit";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Textarea } from "@geiger/ui/textarea";

const PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";
const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

/**
 * Gateway responses tab (REST): the 21 types with defaults and
 * "customized" badges, plus an editor for status/headers/templates and
 * reset-to-default. `types` comes from the list endpoint (defaults +
 * flags); `customizations` holds the stored rows.
 */
export function GatewayResponsesTab({ types = [], customizations = [], loading = false, error = null, onSave, onReset, canWrite = false }) {
  const [selected, setSelected] = useState(null);
  const [resetTarget, setResetTarget] = useState(null);
  const current = customizations.find((entry) => entry.responseType === selected) ?? null;
  const selectedType = types.find((entry) => entry.type === selected) ?? null;

  if (loading) return <LoadingArea label="Loading gateway responses" />;
  if (error) return <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={MessageSquareWarning} title="Could not load gateway responses" description={String(error?.message ?? error)} /></div>;

  const customizationFor = (type) => customizations.find((entry) => entry.responseType === type) ?? null;

  const columns = [
    {
      key: "type",
      header: "Response type",
      render: (entry) => <div className="flex flex-col gap-0.5">
        <span className="font-mono text-sm font-medium text-foreground">{entry.type}</span>
        {entry.defaultMessage ? <span className="text-xs text-text-secondary">{entry.defaultMessage}</span> : null}
      </div>,
    },
    {
      key: "status",
      header: "Status",
      render: (entry) => {
        const custom = customizationFor(entry.type)?.statusCode;
        return <span className="font-mono text-sm tabular-nums text-foreground">
          {custom ?? entry.defaultStatus ?? "—"}
          {custom && String(custom) !== String(entry.defaultStatus) ? <span className="ml-2 text-xs text-text-tertiary line-through">{entry.defaultStatus}</span> : null}
        </span>;
      },
    },
    {
      key: "state",
      header: "Source",
      render: (entry) => entry.customized ? <Badge variant="info">Customized</Badge> : <span className="text-xs text-text-secondary">Default</span>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (entry) => <ActionMenu
        label={`Actions for ${entry.type}`}
        items={[
          { icon: Pencil, label: canWrite ? "Edit" : "View", onSelect: () => setSelected(entry.type) },
          canWrite && entry.customized && { separator: true },
          canWrite && entry.customized && { icon: RotateCcw, label: "Reset to default", destructive: true, onSelect: () => setResetTarget(entry.type) },
        ]}
      />,
    },
  ];

  return <div className="space-y-8">
    <SectionCard bare title="Response types" description="Status codes, headers and body templates for errors the gateway generates itself. Types you leave alone fall back to DEFAULT_4XX or DEFAULT_5XX.">
      <DataTable
        columns={columns}
        data={types}
        getRowKey={(entry) => entry.type}
        onRowClick={(entry) => setSelected(entry.type)}
        empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={MessageSquareWarning} title="No response types" description="The gateway response catalog is unavailable." /></div>}
      />
    </SectionCard>

    <Dialog open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelected(null); }}>
      <DialogContent className="max-w-xl bg-background">
        <DialogHeader>
          <DialogTitle className="font-mono">{selected}</DialogTitle>
          <DialogDescription>Default: {selectedType?.defaultStatus ?? "—"}{selectedType?.defaultMessage ? ` ${selectedType.defaultMessage}` : ""}</DialogDescription>
        </DialogHeader>
        {selected ? <GatewayResponseEditor
          key={selected}
          type={selectedType}
          customization={current}
          onSave={async (input) => { const type = selected; setSelected(null); await onSave?.(type, input); }}
          onReset={() => { setResetTarget(selected); setSelected(null); }}
          onCancel={() => setSelected(null)}
          canWrite={canWrite}
        /> : null}
      </DialogContent>
    </Dialog>

    <Dialog open={Boolean(resetTarget)} onOpenChange={(open) => { if (!open) setResetTarget(null); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reset to default</DialogTitle>
          <DialogDescription>
            Drop the customization for <span className="font-mono font-medium text-foreground">{resetTarget}</span>? It goes back to the default status, headers and body.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setResetTarget(null)}>Cancel</Button>
          <Button className="bg-red-500/90 text-white hover:bg-red-500" onClick={() => { const type = resetTarget; setResetTarget(null); onReset?.(type); }}><RotateCcw className="size-4" />Reset</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

export function GatewayResponseEditor({ type, customization, onSave, onReset, onCancel, canWrite = false }) {
  const [statusCode, setStatusCode] = useState(customization?.statusCode ?? "");
  const [headersText, setHeadersText] = useState(Object.entries(customization?.responseParameters ?? {}).map(([key, value]) => `${key}=${value}`).join("\n"));
  const [templateType, setTemplateType] = useState("application/json");
  const [templateBody, setTemplateBody] = useState(customization?.responseTemplates?.["application/json"] ?? "");

  function save() {
    const responseParameters = {};
    for (const line of headersText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const equals = trimmed.indexOf("=");
      if (equals < 0) continue;
      responseParameters[trimmed.slice(0, equals).trim()] = trimmed.slice(equals + 1).trim();
    }
    onSave?.({
      statusCode: statusCode.trim() === "" ? null : statusCode.trim(),
      responseParameters,
      responseTemplates: templateBody ? { [templateType]: templateBody } : {},
    });
  }

  return <div className="space-y-4">
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Status code" hint="Leave empty to keep the default." htmlFor="gw-status">
        <Input id="gw-status" value={statusCode} onChange={(event) => setStatusCode(event.target.value)} placeholder={String(type?.defaultStatus ?? "")} className="font-mono" disabled={!canWrite} />
      </Field>
      <Field label="Template content type" htmlFor="gw-template-type">
        <Input id="gw-template-type" value={templateType} onChange={(event) => setTemplateType(event.target.value)} className="font-mono" disabled={!canWrite} />
      </Field>
    </div>
    <Field label="Response headers" hint="One gatewayresponse.header.Name=value per line." htmlFor="gw-headers">
      <Textarea id="gw-headers" className="font-mono text-xs" rows={4} value={headersText} onChange={(event) => setHeadersText(event.target.value)} placeholder="gatewayresponse.header.Access-Control-Allow-Origin='*'" disabled={!canWrite} spellCheck={false} />
    </Field>
    <Field label="Body template" hint="$context.error.* variables are available." htmlFor="gw-template">
      <Textarea id="gw-template" className="font-mono text-xs" rows={6} value={templateBody} onChange={(event) => setTemplateBody(event.target.value)} placeholder='{"message": $context.error.messageString}' disabled={!canWrite} spellCheck={false} />
    </Field>
    <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
      {canWrite && (customization || type?.customized) ? <Button type="button" variant="outline" className={`mr-auto ${SECONDARY}`} onClick={onReset}><RotateCcw className="size-4" />Reset to Default</Button> : null}
      {onCancel ? <Button type="button" variant="outline" className={SECONDARY} onClick={onCancel}>{canWrite ? "Cancel" : "Close"}</Button> : null}
      {canWrite ? <Button type="button" className={PRIMARY} onClick={save}>Save Changes</Button> : null}
    </div>
  </div>;
}
