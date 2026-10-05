"use client";

import { useState } from "react";
import { MessageSquareWarning } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { Textarea } from "@geiger/ui/textarea";

/**
 * Gateway responses tab (REST): the 21 types with defaults and
 * "customized" badges, plus an editor for status/headers/templates and
 * reset-to-default. `types` comes from the list endpoint (defaults +
 * flags); `customizations` holds the stored rows.
 */
export function GatewayResponsesTab({ types = [], customizations = [], loading = false, error = null, onSave, onReset, canWrite = false }) {
  const [selected, setSelected] = useState(types[0]?.type ?? "THROTTLED");
  const current = customizations.find((entry) => entry.responseType === selected) ?? null;

  if (loading) return <LogoLoading label="Loading gateway responses…" />;
  if (error) return <EmptyState title="Could not load gateway responses" description={String(error?.message ?? error)} />;
  if (types.length === 0) return <EmptyState icon={MessageSquareWarning} title="No gateway responses" description="The gateway response catalog is unavailable." />;

  return (
    <div className="space-y-4">
      <ScreenHeader title="Gateway responses" description="Customize status codes, headers and body templates for gateway-generated errors. Unspecified types fall back to DEFAULT_4XX/DEFAULT_5XX." />
      <div className="flex flex-wrap gap-2">
        {types.map((entry) => (
          <button
            key={entry.type}
            type="button"
            onClick={() => setSelected(entry.type)}
            className={`flex items-center gap-2 rounded border px-3 py-1 text-xs ${selected === entry.type ? "border-primary font-semibold" : ""}`}
          >
            {entry.type}
            {entry.customized ? <Badge>customized</Badge> : <span className="text-muted-foreground">{entry.defaultStatus}</span>}
          </button>
        ))}
      </div>
      <GatewayResponseEditor
        key={selected}
        type={types.find((entry) => entry.type === selected)}
        customization={current}
        onSave={(input) => onSave?.(selected, input)}
        onReset={() => onReset?.(selected)}
        canWrite={canWrite}
      />
    </div>
  );
}

export function GatewayResponseEditor({ type, customization, onSave, onReset, canWrite = false }) {
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

  return (
    <SectionCard title={`${type?.type ?? "Response"} — default ${type?.defaultStatus ?? ""} ${type?.defaultMessage ?? ""}`}>
      <div className="grid gap-3">
        <div>
          <Label htmlFor="gw-status">Status override (empty = default)</Label>
          <Input id="gw-status" value={statusCode} onChange={(event) => setStatusCode(event.target.value)} placeholder={String(type?.defaultStatus ?? "")} disabled={!canWrite} />
        </div>
        <div>
          <Label htmlFor="gw-headers">Response parameters (one gatewayresponse.header.*=value per line)</Label>
          <Textarea id="gw-headers" className="font-mono text-xs" rows={4} value={headersText} onChange={(event) => setHeadersText(event.target.value)} placeholder="gatewayresponse.header.Access-Control-Allow-Origin='*'" disabled={!canWrite} spellCheck={false} />
        </div>
        <div>
          <Label htmlFor="gw-template-type">Template content type</Label>
          <Input id="gw-template-type" value={templateType} onChange={(event) => setTemplateType(event.target.value)} disabled={!canWrite} />
        </div>
        <div>
          <Label htmlFor="gw-template">Response template ($context.error.* available)</Label>
          <Textarea id="gw-template" className="font-mono text-xs" rows={6} value={templateBody} onChange={(event) => setTemplateBody(event.target.value)} placeholder='{"message": $context.error.messageString}' disabled={!canWrite} spellCheck={false} />
        </div>
        {canWrite ? (
          <div className="flex gap-2">
            <Button type="button" onClick={save}>Save customization</Button>
            <Button type="button" variant="outline" onClick={onReset}>Reset to default</Button>
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
