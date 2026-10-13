"use client";

import { useState } from "react";
import { Globe, Loader2, Plus, X } from "lucide-react";
import { EmptyState, Field, SettingRow, SettingsList } from "@/components/internal/shared/screen_kit";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Checkbox } from "@geiger/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { toast } from "sonner";

const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "*"];

const methodId = (method) => (method === "*" ? "any" : method.toLowerCase());

const PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";
const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

const EMPTY_CORS = {
  allowOrigins: [],
  allowMethods: [],
  allowHeaders: [],
  exposeHeaders: [],
  maxAge: 0,
  allowCredentials: false,
};

function MethodChecks({ prefix, methods, selected, onToggle }) {
  return <div className="flex flex-wrap gap-2">
    {methods.map((method) => <label
      key={method}
      htmlFor={`${prefix}-${methodId(method)}`}
      className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-surface-subtle px-2.5 py-1.5 transition-colors hover:bg-surface-active"
    >
      <Checkbox id={`${prefix}-${methodId(method)}`} checked={selected.includes(method)} onCheckedChange={() => onToggle(method)} />
      <span className="font-mono text-xs text-foreground">{method === "*" ? "* (any)" : method}</span>
    </label>)}
  </div>;
}

/**
 * HTTP managed-CORS editor. `value`/`onChange` make it a controlled form;
 * `onSave` persists through the CORS management API.
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
      toast.error("Turn off Allow credentials before allowing every origin (*).");
      return;
    }
    if (!cors.allowOrigins.includes(origin)) update({ allowOrigins: [...cors.allowOrigins, origin] });
    setOriginInput("");
  }

  function toggle(list, entry) {
    update({ [list]: cors[list].includes(entry) ? cors[list].filter((item) => item !== entry) : [...cors[list], entry] });
  }

  const starWithCredentials = cors.allowOrigins.includes("*") && cors.allowCredentials;

  return <div className="space-y-8">
    {error ? <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={Globe} title="Could not load CORS" description={String(error?.message ?? error)} /></div> : null}

    <div className="space-y-4 rounded-xl border border-border bg-surface-card p-4">
      <Field label="Allowed origins" hint="Browsers on these origins may call the API. Add * to allow any origin." htmlFor="cors-origin-input">
        <div className="space-y-3">
          {cors.allowOrigins.length ? <div className="flex flex-wrap gap-2">
            {cors.allowOrigins.map((origin) => <span key={origin} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-subtle py-0.5 pl-2.5 pr-1 font-mono text-xs text-foreground">
              {origin}
              <button
                type="button"
                aria-label={`Remove ${origin}`}
                className="rounded-full p-0.5 text-text-secondary transition-colors hover:bg-surface-active hover:text-foreground"
                onClick={() => update({ allowOrigins: cors.allowOrigins.filter((item) => item !== origin) })}
              ><X className="size-3" /></button>
            </span>)}
          </div> : <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-text-secondary">No origins yet — no CORS headers are sent.</p>}
          <div className="flex gap-2">
            <Input
              id="cors-origin-input"
              value={originInput}
              onChange={(event) => setOriginInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addOrigin(); } }}
              placeholder="https://example.com or *"
              aria-label="Add origin"
              className="font-mono"
            />
            <Button type="button" variant="outline" className={SECONDARY} onClick={addOrigin}><Plus className="size-4" />Add</Button>
          </div>
        </div>
      </Field>

      <div className="border-t border-border pt-4">
        <Field label="Allowed methods">
          <MethodChecks prefix="cors-method" methods={HTTP_METHODS} selected={cors.allowMethods} onToggle={(method) => toggle("allowMethods", method)} />
        </Field>
      </div>

      <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
        <Field label="Allowed headers" hint="Comma separated." htmlFor="cors-allow-headers">
          <Input id="cors-allow-headers" className="font-mono" value={(cors.allowHeaders ?? []).join(", ")} onChange={(event) => update({ allowHeaders: event.target.value.split(",").map((part) => part.trim()).filter(Boolean) })} placeholder="content-type, authorization" />
        </Field>
        <Field label="Exposed headers" hint="Comma separated." htmlFor="cors-expose-headers">
          <Input id="cors-expose-headers" className="font-mono" value={(cors.exposeHeaders ?? []).join(", ")} onChange={(event) => update({ exposeHeaders: event.target.value.split(",").map((part) => part.trim()).filter(Boolean) })} placeholder="x-request-id" />
        </Field>
      </div>

      <div className="border-t border-border pt-4">
        <SettingsList>
          <SettingRow
            title="Max age"
            description="How long browsers may cache a preflight, 0–86400 seconds."
            control={<Input id="cors-max-age" aria-label="Max age in seconds" type="number" min={0} max={86400} className="w-28 text-right tabular-nums" value={cors.maxAge ?? 0} onChange={(event) => update({ maxAge: Number(event.target.value) })} />}
          />
          <SettingRow
            title="Allow credentials"
            description="Let browsers send cookies and authorization headers cross-origin."
            checked={cors.allowCredentials}
            onCheckedChange={(checked) => update({ allowCredentials: checked === true })}
          />
        </SettingsList>
        {starWithCredentials ? <p className="mt-3 text-xs text-red-500">Credentials can&apos;t be allowed while every origin (*) is allowed. Remove * or turn this off.</p> : null}
      </div>
    </div>

    <div className="flex items-center justify-end gap-3">
      <p className="mr-auto text-xs text-text-secondary">Preflight requests are answered by the gateway without invoking authorizers.</p>
      <Button type="button" className={PRIMARY} disabled={saving || starWithCredentials} onClick={() => onSave?.(cors)}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {saving ? "Saving…" : "Save Changes"}
      </Button>
    </div>
  </div>;
}

/**
 * REST "Enable CORS" dialog: options with a preview of the OPTIONS mock
 * method and headers to be created.
 */
export function EnableCorsDialog({ open, onOpenChange, onConfirm }) {
  const [allowOrigin, setAllowOrigin] = useState("'*'");
  const [allowHeaders, setAllowHeaders] = useState("Content-Type,X-Amz-Date,Authorization,X-Api-Key");
  const [methods, setMethods] = useState(["GET", "POST", "OPTIONS"]);
  return <Dialog open={Boolean(open)} onOpenChange={(next) => onOpenChange?.(next)}>
    <DialogContent className="max-w-xl bg-background">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><Globe className="size-4" />Enable CORS</DialogTitle>
        <DialogDescription>Creates an OPTIONS mock method returning 200 with Access-Control-Allow-* headers, and adds the Allow-Origin mapping to the selected methods.</DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Allow origin" hint="A quoted literal, e.g. '*'." htmlFor="enable-cors-origin">
            <Input id="enable-cors-origin" className="font-mono" value={allowOrigin} onChange={(event) => setAllowOrigin(event.target.value)} />
          </Field>
          <Field label="Allow headers" htmlFor="enable-cors-headers">
            <Input id="enable-cors-headers" className="font-mono" value={allowHeaders} onChange={(event) => setAllowHeaders(event.target.value)} />
          </Field>
        </div>
        <Field label="Methods">
          <MethodChecks
            prefix="enable-cors-method"
            methods={HTTP_METHODS.filter((method) => method !== "*")}
            selected={methods}
            onToggle={(method) => setMethods(methods.includes(method) ? methods.filter((item) => item !== method) : [...methods, method])}
          />
        </Field>
        <div className="rounded-lg border border-border bg-surface-subtle px-3 py-2 text-xs text-text-secondary">
          <p className="mb-1 font-medium text-muted-foreground">Preview</p>
          <p className="font-mono">OPTIONS → MOCK 200 with method.response.header.Access-Control-Allow-Origin = {allowOrigin}; selected methods gain method.response.header.Access-Control-Allow-Origin on their 200 responses.</p>
        </div>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" className={SECONDARY} onClick={() => onOpenChange?.(false)}>Cancel</Button>
        <Button type="button" className={PRIMARY} onClick={() => { onConfirm?.({ allowOrigin, allowMethods: methods, allowHeaders: allowHeaders.split(",").map((part) => part.trim()).filter(Boolean) }); onOpenChange?.(false); }}>Create OPTIONS Mock</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
