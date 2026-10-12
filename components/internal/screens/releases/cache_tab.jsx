"use client";

import { useEffect, useState } from "react";
import { DatabaseZap } from "lucide-react";
import { EmptyState, LoadingArea, SectionCard } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
import { Checkbox } from "@geiger/ui/checkbox";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";

const SIZES = ["0.5", "1.6", "6.1", "13.5", "28.4", "58.2", "118", "237"];
const STRATEGIES = ["FAIL_WITH_403", "SUCCEED_WITH_RESPONSE_HEADER", "SUCCEED_WITHOUT_RESPONSE_HEADER"];

async function api(projectId, apiId, path, options = {}) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/apis/${encodeURIComponent(apiId)}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

/**
 * Stage → Cache sub-tab (S09 §2 + §4): enable, capacity, default TTL,
 * encryption, per-method overrides table, flush (type stage name to
 * confirm) and the `Cache-Control: max-age=0` authorization strategy.
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
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api(project.id, apiRef, stagePath).then(
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
  }, [project.id, apiRef, stage.name]);

  if (!can("pods.apis.view")) {
    return <EmptyState icon={DatabaseZap} title="Access unavailable" description="Your current team access does not allow this screen." />;
  }
  if (state.status === "loading") return <LoadingArea label="Loading cache settings" />;
  if (state.status === "error") return <EmptyState icon={DatabaseZap} title="Cache unavailable" description="Could not load the stage cache settings." />;

  async function save() {
    setBusy(true);
    try {
      const methodSettings = {};
      for (const row of methodRows) {
        if (!row.key) continue;
        methodSettings[row.key] = { cachingEnabled: Boolean(row.enabled), cacheTtlInSeconds: Number(row.ttl) };
      }
      const cache = await api(project.id, apiRef, stagePath, {
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
      await api(project.id, apiRef, stagePath, { method: "DELETE" });
      setConfirm("");
      toast.success("Cache flushed.");
      onChanged?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  return <div className="space-y-4">
    <SectionCard title="Stage cache" description="Caches GET responses per method (TTL 0–3600 s). Query params outside the cache keys are ignored.">
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
        Safety rule (on by default): authenticated responses never cross consumers — the caller identity is part of the
        cache key. Opt out per project with <span className="font-mono">features.cacheSharedAcrossPrincipals</span> (AWS behavior).
      </div>
      <div className="mt-4 flex items-center gap-2">
        <Checkbox id={`cache-enabled-${stage.id}`} checked={form.enabled} onCheckedChange={(value) => setForm({ ...form, enabled: value === true })} />
        <Label htmlFor={`cache-enabled-${stage.id}`} className="font-normal">Enable cache for this stage</Label>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`cache-size-${stage.id}`}>Capacity (GB)</Label>
          <Select value={form.size} onValueChange={(value) => setForm({ ...form, size: value })}>
            <SelectTrigger id={`cache-size-${stage.id}`}><SelectValue /></SelectTrigger>
            <SelectContent>{SIZES.map((size) => <SelectItem key={size} value={size}>{size}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`cache-ttl-${stage.id}`}>Default TTL (s)</Label>
          <Input id={`cache-ttl-${stage.id}`} type="number" min={0} max={3600} value={form.defaultTtl} onChange={(event) => setForm({ ...form, defaultTtl: event.target.value })} />
        </div>
      </div>
      <div className="mt-4 space-y-2">
        <div className="flex items-center gap-2">
          <Checkbox id={`cache-encrypted-${stage.id}`} checked={form.encrypted} onCheckedChange={(value) => setForm({ ...form, encrypted: value === true })} />
          <Label htmlFor={`cache-encrypted-${stage.id}`} className="font-normal">Encrypt cached bodies (AES-256-GCM)</Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id={`cache-require-auth-${stage.id}`} checked={form.requireAuth} onCheckedChange={(value) => setForm({ ...form, requireAuth: value === true })} />
          <Label htmlFor={`cache-require-auth-${stage.id}`} className="font-normal leading-snug">Require authorization for Cache-Control: max-age=0 invalidation</Label>
        </div>
      </div>
      <div className="mt-4 space-y-1">
        <Label htmlFor={`cache-strategy-${stage.id}`}>Unauthorized invalidation strategy</Label>
        <Select value={form.strategy} onValueChange={(value) => setForm({ ...form, strategy: value })}>
          <SelectTrigger id={`cache-strategy-${stage.id}`}><SelectValue /></SelectTrigger>
          <SelectContent>{STRATEGIES.map((entry) => <SelectItem key={entry} value={entry}>{entry}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <div className="mt-4 space-y-2">
        <Label>Per-method overrides (resourcePath/METHOD or */*)</Label>
        {methodRows.map((row, index) => <div key={index} className="flex flex-wrap items-center gap-2 text-xs">
          <Input className="min-w-0 flex-1 basis-full font-mono sm:basis-0" value={row.key} placeholder="/pets/GET" aria-label="Resource path and method" onChange={(event) => setMethodRows(methodRows.map((entry, at) => (at === index ? { ...entry, key: event.target.value } : entry)))} />
          <Input className="w-28" type="number" min={0} max={3600} value={row.ttl} aria-label="TTL (s)" onChange={(event) => setMethodRows(methodRows.map((entry, at) => (at === index ? { ...entry, ttl: event.target.value } : entry)))} />
          <div className="flex items-center gap-2">
            <Checkbox id={`cache-row-${stage.id}-${index}`} checked={row.enabled} onCheckedChange={(value) => setMethodRows(methodRows.map((entry, at) => (at === index ? { ...entry, enabled: value === true } : entry)))} />
            <Label htmlFor={`cache-row-${stage.id}-${index}`} className="font-normal">cache</Label>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setMethodRows(methodRows.filter((_, at) => at !== index))}>Remove</Button>
        </div>)}
        <Button variant="outline" size="sm" onClick={() => setMethodRows([...methodRows, { key: "", ttl: 300, enabled: true }])}>Add override</Button>
      </div>
      <Button size="sm" className="mt-4" disabled={busy || !can("pods.stage.write")} onClick={save}>Save cache settings</Button>
    </SectionCard>
    <SectionCard title="Flush entire cache" description="Invalidates every entry immediately (O(1) epoch bump).">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="w-full sm:w-64" value={confirm} placeholder={`Type ${stage.name} to confirm`} onChange={(event) => setConfirm(event.target.value)} />
        <Button variant="destructive" disabled={busy || !can("pods.cache.flush")} onClick={flush}>Flush cache</Button>
      </div>
    </SectionCard>
  </div>;
}
