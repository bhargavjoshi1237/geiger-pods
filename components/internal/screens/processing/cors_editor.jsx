"use client";

import { useState } from "react";
import { Globe } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { toast } from "sonner";

const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "*"];

const EMPTY_CORS = {
  allowOrigins: [],
  allowMethods: [],
  allowHeaders: [],
  exposeHeaders: [],
  maxAge: 0,
  allowCredentials: false,
};

/**
 * HTTP managed-CORS editor (standalone; the orchestrator wires it into the
 * API detail tabs later). `value`/`onChange` make it a controlled form;
 * `onSave` persists through the S06 CORS management API.
 */
export function CorsEditor({ value, onChange, onSave, saving = false, error = null }) {
  const cors = { ...EMPTY_CORS, ...(value ?? {}) };
  const [originInput, setOriginInput] = useState("");

  function update(patch) {
    onChange?.({ ...cors, ...patch });
  }

  function addOrigin() {
    const origin = originInput.trim();
    if (!origin) return;
    if (origin === "*" && cors.allowCredentials) {
      toast.error("allowCredentials must not be true when allowOrigins contains *.");
      return;
    }
    if (!cors.allowOrigins.includes(origin)) update({ allowOrigins: [...cors.allowOrigins, origin] });
    setOriginInput("");
  }

  function toggle(list, entry) {
    update({ [list]: cors[list].includes(entry) ? cors[list].filter((item) => item !== entry) : [...cors[list], entry] });
  }

  const starWithCredentials = cors.allowOrigins.includes("*") && cors.allowCredentials;

  return (
    <div className="space-y-4">
      <ScreenHeader title="CORS" description="Managed cross-origin config for this HTTP API. Preflights are answered by the gateway without invoking authorizers." />
      {error ? <EmptyState title="Could not load CORS" description={String(error?.message ?? error)} /> : null}
      <SectionCard title="Allowed origins">
        <div className="flex flex-wrap gap-2">
          {cors.allowOrigins.length === 0 ? <p className="text-sm text-muted-foreground">No origins yet — no CORS headers will be sent.</p> : null}
          {cors.allowOrigins.map((origin) => (
            <button key={origin} type="button" className="rounded-full border px-3 py-1 text-xs" onClick={() => update({ allowOrigins: cors.allowOrigins.filter((item) => item !== origin) })} title="Remove origin">
              {origin} ✕
            </button>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <Input value={originInput} onChange={(event) => setOriginInput(event.target.value)} placeholder="https://example.com or *" aria-label="Add origin" />
          <Button type="button" onClick={addOrigin}>Add</Button>
        </div>
      </SectionCard>
      <SectionCard title="Allowed methods">
        <div className="flex flex-wrap gap-2">
          {HTTP_METHODS.map((method) => (
            <label key={method} className="flex items-center gap-1 rounded border px-2 py-1 text-xs">
              <input type="checkbox" checked={cors.allowMethods.includes(method)} onChange={() => toggle("allowMethods", method)} />
              {method}
            </label>
          ))}
        </div>
      </SectionCard>
      <SectionCard title="Headers and credentials">
        <div className="grid gap-3">
          <div>
            <Label htmlFor="cors-allow-headers">Allowed headers (comma separated)</Label>
            <Input id="cors-allow-headers" value={(cors.allowHeaders ?? []).join(", ")} onChange={(event) => update({ allowHeaders: event.target.value.split(",").map((part) => part.trim()).filter(Boolean) })} />
          </div>
          <div>
            <Label htmlFor="cors-expose-headers">Exposed headers (comma separated)</Label>
            <Input id="cors-expose-headers" value={(cors.exposeHeaders ?? []).join(", ")} onChange={(event) => update({ exposeHeaders: event.target.value.split(",").map((part) => part.trim()).filter(Boolean) })} />
          </div>
          <div>
            <Label htmlFor="cors-max-age">Max age (0–86400 seconds)</Label>
            <Input id="cors-max-age" type="number" min={0} max={86400} value={cors.maxAge ?? 0} onChange={(event) => update({ maxAge: Number(event.target.value) })} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={cors.allowCredentials} onChange={(event) => update({ allowCredentials: event.target.checked })} />
            Allow credentials
          </label>
          {starWithCredentials ? <p className="text-sm text-red-600">AWS rejects this combination: allowCredentials must not be true when allowOrigins contains *.</p> : null}
        </div>
      </SectionCard>
      <Button type="button" disabled={saving || starWithCredentials} onClick={() => onSave?.(cors)}>
        {saving ? "Saving…" : "Save CORS"}
      </Button>
    </div>
  );
}

/**
 * REST "Enable CORS" dialog: AWS-style options with a preview of the OPTIONS
 * mock method and headers to be created.
 */
export function EnableCorsDialog({ open, onOpenChange, onConfirm }) {
  const [allowOrigin, setAllowOrigin] = useState("'*'");
  const [allowHeaders, setAllowHeaders] = useState("Content-Type,X-Amz-Date,Authorization,X-Api-Key");
  const [methods, setMethods] = useState(["GET", "POST", "OPTIONS"]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true" aria-label="Enable CORS">
      <div className="w-full max-w-lg rounded-lg bg-background p-6 shadow-xl">
        <h2 className="flex items-center gap-2 text-lg font-semibold"><Globe size={18} /> Enable CORS</h2>
        <p className="mt-1 text-sm text-muted-foreground">Creates an OPTIONS mock method returning 200 with Access-Control-Allow-* headers, and adds the Allow-Origin mapping to the selected methods.</p>
        <div className="mt-4 grid gap-3">
          <div>
            <Label htmlFor="enable-cors-origin">Allow origin (quoted literal)</Label>
            <Input id="enable-cors-origin" value={allowOrigin} onChange={(event) => setAllowOrigin(event.target.value)} />
          </div>
          <div>
            <Label htmlFor="enable-cors-headers">Allow headers</Label>
            <Input id="enable-cors-headers" value={allowHeaders} onChange={(event) => setAllowHeaders(event.target.value)} />
          </div>
          <div className="flex flex-wrap gap-2">
            {HTTP_METHODS.filter((method) => method !== "*").map((method) => (
              <label key={method} className="flex items-center gap-1 rounded border px-2 py-1 text-xs">
                <input type="checkbox" checked={methods.includes(method)} onChange={() => setMethods(methods.includes(method) ? methods.filter((item) => item !== method) : [...methods, method])} />
                {method}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Preview: OPTIONS → MOCK 200 with method.response.header.Access-Control-Allow-Origin = {allowOrigin}; selected methods gain method.response.header.Access-Control-Allow-Origin on their 200 responses.</p>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange?.(false)}>Cancel</Button>
          <Button type="button" onClick={() => { onConfirm?.({ allowOrigin, allowMethods: methods, allowHeaders: allowHeaders.split(",").map((part) => part.trim()).filter(Boolean) }); onOpenChange?.(false); }}>Create OPTIONS mock</Button>
        </div>
      </div>
    </div>
  );
}
