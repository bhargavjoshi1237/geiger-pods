"use client";

import { useEffect, useState } from "react";
import { DatabaseZap, Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { EmptyState, Field, LoadingArea, SectionCard, SettingRow, SettingsList } from "@/components/internal/shared/screen_kit";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { Switch } from "@geiger/ui/switch";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";

const SIZES = ["0.5", "1.6", "6.1", "13.5", "28.4", "58.2", "118", "237"];
const STRATEGIES = ["FAIL_WITH_403", "SUCCEED_WITH_RESPONSE_HEADER", "SUCCEED_WITHOUT_RESPONSE_HEADER"];
const STRATEGY_LABEL = {
  FAIL_WITH_403: "Reject with 403 Forbidden",
  SUCCEED_WITH_RESPONSE_HEADER: "Serve from cache, add a warning header",
  SUCCEED_WITHOUT_RESPONSE_HEADER: "Serve from cache silently",
};
const PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";
const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

async function call(projectId, apiId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/apis/${encodeURIComponent(apiId)}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

/**
 * Stage cache settings: enable, capacity, default TTL, encryption,
 * per-method overrides, the max-age=0 invalidation rule and flush.
 *
 * @param {{ api: object, stage: object, onChanged?: () => void }} props
 */
export function CacheTab({ api, stage, onChanged }) {
  const { project } = useProject();
  const { can } = useRbac();
  const apiRef = api.id ?? api.publicId;
  const stagePath = `/stages/${encodeURIComponent(stage.name)}/cache`;
  const [state, setState] = useState({ status: "loading", cache: null });
  const [form, setForm] = useState({ enabled: false, size: "0.5", defaultTtl: 300, encrypted: false, requireAuth: true, strategy: "SUCCEED_WITH_RESPONSE_HEADER" });
  const [methodRows, setMethodRows] = useState([]);
  const [confirm, setConfirm] = useState("");
  const [flushOpen, setFlushOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    call(project.id, apiRef, stagePath).then(
      (cache) => {
        if (!alive) return;
        setState({ status: "ready", cache });
        setForm({
          enabled: Boolean(cache.enabled),
          size: cache.size ?? "0.5",
          defaultTtl: cache.defaultTtl ?? 300,
          encrypted: Boolean(cache.encrypted),
          requireAuth: cache.requireAuthorizationForCacheControl !== false,
          strategy: cache.unauthorizedStrategy ?? "SUCCEED_WITH_RESPONSE_HEADER",
        });
        setMethodRows(Object.entries(cache.methodSettings ?? {}).map(([key, value]) => ({ key, ttl: value.cacheTtlInSeconds ?? 300, enabled: value.cachingEnabled !== false })));
      },
      () => { if (alive) setState({ status: "error", cache: null }); },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, apiRef, stage.name, reloadKey]);

  if (!can("pods.apis.view")) {
    return <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={DatabaseZap} title="Access unavailable" description="Your current team access does not allow this screen." /></div>;
  }
  if (state.status === "loading") return <LoadingArea label="Loading cache settings" />;
  if (state.status === "error") return <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={DatabaseZap} title="Cache unavailable" description="Could not load the stage cache settings." action={<Button variant="outline" className={SECONDARY} onClick={() => { setState({ status: "loading", cache: null }); setReloadKey((key) => key + 1); }}>Retry</Button>} /></div>;

  async function save() {
    setBusy(true);
    try {
      const methodSettings = {};
      for (const row of methodRows) {
        if (!row.key) continue;
        methodSettings[row.key] = { cachingEnabled: Boolean(row.enabled), cacheTtlInSeconds: Number(row.ttl) };
      }
      const cache = await call(project.id, apiRef, stagePath, {
        method: "PUT",
        body: JSON.stringify({
          enabled: form.enabled,
          size: form.size,
          defaultTtl: Number(form.defaultTtl),
          encrypted: form.encrypted,
          requireAuthorizationForCacheControl: form.requireAuth,
          unauthorizedStrategy: form.strategy,
          methodSettings,
        }),
      });
      setState({ status: "ready", cache });
      toast.success("Cache settings saved.");
      onChanged?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function flush() {
    if (confirm !== stage.name) {
      toast.error(`Type the stage name (${stage.name}) to confirm.`);
      return;
    }
    setBusy(true);
    try {
      await call(project.id, apiRef, stagePath, { method: "DELETE" });
      setConfirm("");
      setFlushOpen(false);
      toast.success("Cache flushed.");
      onChanged?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  const updateRow = (index, patch) => setMethodRows(methodRows.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)));
  const addRow = () => setMethodRows([...methodRows, { key: "", ttl: 300, enabled: true }]);
  const canWrite = can("pods.stage.write");
  const closeFlush = () => {
    setFlushOpen(false);
    setConfirm("");
  };

  return <div className="space-y-8">
    <SectionCard bare title="Response cache" description="Cache GET responses on this stage for up to an hour. Query parameters that aren't part of the cache key are ignored.">
      <div className="space-y-4">
        <div className="space-y-4 rounded-xl border border-border bg-surface-card p-4">
          <SettingsList>
            <SettingRow
              title="Enable cache"
              description="Serve repeat GET requests from the stage cache."
              checked={form.enabled}
              onCheckedChange={(value) => setForm({ ...form, enabled: value === true })}
            />
          </SettingsList>
          <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
            <Field label="Capacity (GB)" htmlFor={`cache-size-${stage.id}`}>
              <Select value={form.size} onValueChange={(value) => setForm({ ...form, size: value })}>
                <SelectTrigger id={`cache-size-${stage.id}`}><SelectValue /></SelectTrigger>
                <SelectContent>{SIZES.map((size) => <SelectItem key={size} value={size}>{size} GB</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Default TTL (seconds)" hint="0 to 3600." htmlFor={`cache-ttl-${stage.id}`}>
              <Input id={`cache-ttl-${stage.id}`} type="number" min={0} max={3600} value={form.defaultTtl} onChange={(event) => setForm({ ...form, defaultTtl: event.target.value })} />
            </Field>
          </div>
          <SettingsList className="border-t border-border pt-4">
            <SettingRow
              title="Encrypt cached responses"
              description="Cached bodies are stored encrypted with AES-256-GCM."
              checked={form.encrypted}
              onCheckedChange={(value) => setForm({ ...form, encrypted: value === true })}
            />
            <SettingRow
              title="Require authorization to bypass the cache"
              description="Only authorized callers may force a fresh response with Cache-Control: max-age=0."
              checked={form.requireAuth}
              onCheckedChange={(value) => setForm({ ...form, requireAuth: value === true })}
            />
          </SettingsList>
          <div className="border-t border-border pt-4">
            <Field label="When an unauthorized caller tries to bypass" htmlFor={`cache-strategy-${stage.id}`}>
              <Select value={form.strategy} onValueChange={(value) => setForm({ ...form, strategy: value })}>
                <SelectTrigger id={`cache-strategy-${stage.id}`} className="sm:max-w-sm"><SelectValue /></SelectTrigger>
                <SelectContent>{STRATEGIES.map((entry) => <SelectItem key={entry} value={entry}>{STRATEGY_LABEL[entry] ?? entry}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          </div>
        </div>
        <div className="flex items-start gap-2.5 rounded-xl border border-border bg-surface-subtle px-4 py-3 text-xs text-text-secondary">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-400" />
          <p>Responses to authenticated requests are cached per caller, so one consumer never receives another&apos;s cached data. A project can opt out with the <span className="font-mono text-muted-foreground">cacheSharedAcrossPrincipals</span> feature flag.</p>
        </div>
      </div>
    </SectionCard>

    <SectionCard
      bare
      title="Per-method overrides"
      description="Change caching for individual methods. Use resourcePath/METHOD, or */* for every method."
      action={methodRows.length ? <Button size="sm" variant="outline" className={SECONDARY} onClick={addRow}><Plus className="size-4" />Add Override</Button> : null}
    >
      {methodRows.length ? <div className="space-y-2">
        {methodRows.map((row, index) => <div key={index} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface-card px-4 py-3">
          <Input className="min-w-0 flex-1 basis-full font-mono sm:basis-0" value={row.key} placeholder="/pets/GET" aria-label="Resource path and method" onChange={(event) => updateRow(index, { key: event.target.value })} />
          <div className="flex items-center gap-2">
            <Input className="w-24" type="number" min={0} max={3600} value={row.ttl} aria-label="TTL (s)" onChange={(event) => updateRow(index, { ttl: event.target.value })} />
            <span className="text-xs text-text-secondary">sec</span>
          </div>
          <label htmlFor={`cache-row-${stage.id}-${index}`} className="flex items-center gap-2 text-xs text-text-secondary">
            <Switch id={`cache-row-${stage.id}-${index}`} checked={row.enabled} onCheckedChange={(value) => updateRow(index, { enabled: value === true })} />
            Cache
          </label>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Remove override"
            className="text-text-secondary hover:bg-surface-active hover:text-foreground"
            onClick={() => setMethodRows(methodRows.filter((_, at) => at !== index))}
          ><Trash2 className="size-4" /></Button>
        </div>)}
      </div> : <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
        icon={DatabaseZap}
        title="No overrides yet"
        description="Every method uses the defaults above."
        action={<Button variant="outline" className={SECONDARY} onClick={addRow}><Plus className="size-4" />Add Override</Button>}
      /></div>}
      {canWrite ? <div className="mt-4 flex justify-end">
        <Button size="sm" className={PRIMARY} disabled={busy} onClick={save}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {busy ? "Saving…" : "Save Changes"}
        </Button>
      </div> : null}
    </SectionCard>

    {can("pods.cache.flush") ? <SectionCard
      bare
      title="Flush cache"
      bodyPadding={false}
      description="Invalidate every cached entry on this stage immediately."
      action={<Button size="sm" className="bg-red-500/90 text-white hover:bg-red-500" disabled={busy} onClick={() => setFlushOpen(true)}><DatabaseZap className="size-4" />Flush Cache</Button>}
    /> : null}

    <Dialog open={flushOpen} onOpenChange={(next) => { if (!next) closeFlush(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Flush cache</DialogTitle>
          <DialogDescription>
            Invalidate every cached entry on <span className="font-medium text-foreground">{stage.name}</span>? The next requests go to the backend. This action can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>
        <Field label={`Type ${stage.name} to confirm`} htmlFor={`cache-flush-${stage.id}`}>
          <Input id={`cache-flush-${stage.id}`} className="font-mono" value={confirm} placeholder={stage.name} autoFocus onChange={(event) => setConfirm(event.target.value)} />
        </Field>
        <DialogFooter>
          <Button variant="ghost" onClick={closeFlush}>Cancel</Button>
          <Button className="bg-red-500/90 text-white hover:bg-red-500" disabled={busy || confirm !== stage.name} onClick={flush}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <DatabaseZap className="h-4 w-4" />}Flush Cache
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
