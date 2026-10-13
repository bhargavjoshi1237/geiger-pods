"use client";

// Data containers that mount the presentational processing editors inside the
// API detail tabs. Each container owns loading/empty/error states and the
// management-API calls; the editors stay pure.

import { useCallback, useEffect, useState } from "react";
import { Database, Globe, MessageSquareWarning } from "lucide-react";
import { EmptyState, LoadingArea } from "@/components/internal/shared/screen_kit";
import { Button } from "@geiger/ui/button";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { fetchApis } from "./api_list";
import { CorsEditor } from "../processing/cors_editor";
import { ModelsTab } from "../processing/models_tab";
import { GatewayResponsesTab } from "../processing/gateway_responses_tab";

const RETRY_CLASS = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

function Unavailable({ icon, title, error, onRetry }) {
  return <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={icon} title={title} description={error} action={<Button variant="outline" className={RETRY_CLASS} onClick={onRetry}>Retry</Button>} /></div>;
}

/** Models tab container: list, create, update, delete via /models. */
export function ModelsPanel({ api }) {
  const { project } = useProject();
  const { can } = useRbac();
  const apiRef = api.publicId ?? api.id;
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [busy, setBusy] = useState(false);
  const canWrite = can("pods.model.write");

  const refresh = useCallback(async () => {
    setState({ status: "loading", items: [], error: null });
    try {
      const data = await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/models?limit=100`);
      setState({ status: "ready", items: data.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [project.id, apiRef]);

  useEffect(() => {
    let alive = true;
    fetchApis(project.id, `/${encodeURIComponent(apiRef)}/models?limit=100`).then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id, apiRef]);

  const create = async (input) => {
    setBusy(true);
    try {
      await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/models`, {
        method: "POST",
        body: JSON.stringify({ name: input.name, contentType: input.contentType, schema: input.schema, description: input.description }),
      });
      toast.success(`Created model ${input.name}.`);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const update = async (model, input) => {
    setBusy(true);
    try {
      await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/models/${encodeURIComponent(model.name)}`, {
        method: "PATCH",
        headers: { "If-Match": String(model.version) },
        body: JSON.stringify({ contentType: input.contentType, schema: input.schema, description: input.description }),
      });
      toast.success(`Saved model ${model.name}.`);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (model) => {
    setBusy(true);
    try {
      await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/models/${encodeURIComponent(model.name)}`, {
        method: "DELETE",
        headers: { "If-Match": String(model.version) },
      });
      toast.success(`Deleted model ${model.name}.`);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  if (state.status === "loading") return <LoadingArea panel label="Loading models" />;
  if (state.status === "error") {
    return <Unavailable icon={Database} title="Models unavailable" error={state.error} onRetry={refresh} />;
  }
  return <ModelsTab
    models={state.items}
    loading={false}
    error={null}
    onCreate={create}
    onUpdate={update}
    onDelete={remove}
    canWrite={canWrite && !busy}
  />;
}

/** CORS tab container (HTTP): managed config via /cors. */
export function CorsPanel({ api }) {
  const { project } = useProject();
  const { can } = useRbac();
  const apiRef = api.publicId ?? api.id;
  const [state, setState] = useState({ status: "loading", cors: null, version: 0, error: null });
  const [saving, setSaving] = useState(false);
  const canWrite = can("pods.api.update");

  const refresh = useCallback(async () => {
    setState({ status: "loading", cors: null, version: 0, error: null });
    try {
      const data = await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/cors`);
      setState({ status: "ready", cors: data.cors ?? null, version: data.version ?? 0, error: null });
    } catch (error) {
      setState({ status: "error", cors: null, version: 0, error: error.message });
    }
  }, [project.id, apiRef]);

  useEffect(() => {
    let alive = true;
    fetchApis(project.id, `/${encodeURIComponent(apiRef)}/cors`).then(
      (data) => { if (alive) setState({ status: "ready", cors: data.cors ?? null, version: data.version ?? 0, error: null }); },
      (error) => { if (alive) setState({ status: "error", cors: null, version: 0, error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id, apiRef]);

  if (state.status === "loading") return <LoadingArea panel label="Loading CORS" />;
  if (state.status === "error") {
    return <Unavailable icon={Globe} title="CORS unavailable" error={state.error} onRetry={refresh} />;
  }

  const save = async (cors) => {
    if (!canWrite) {
      toast.error("Your current team access does not allow saving CORS.");
      return;
    }
    setSaving(true);
    try {
      const saved = await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/cors`, {
        method: "PUT",
        headers: { "If-Match": String(state.version) },
        body: JSON.stringify(cors),
      });
      setState({ status: "ready", cors: saved.cors ?? null, version: saved.version ?? 0, error: null });
      toast.success("Saved CORS. Preflights are answered without invoking authorizers.");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  return <CorsEditor
    value={state.cors}
    onChange={(next) => setState((current) => ({ ...current, cors: next }))}
    onSave={save}
    saving={saving}
    error={null}
  />;
}

/** Gateway responses tab container (REST): 21 types + customizations. */
export function GatewayResponsesPanel({ api }) {
  const { project } = useProject();
  const { can } = useRbac();
  const apiRef = api.publicId ?? api.id;
  const [state, setState] = useState({ status: "loading", types: [], customizations: [], error: null });
  const canWrite = can("pods.gateway_response.write");

  const load = useCallback(async () => {
    setState({ status: "loading", types: [], customizations: [], error: null });
    try {
      const types = await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/gateway-responses`);
      const customized = [];
      for (const entry of types.filter((type) => type.customized)) {
        try {
          const row = await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/gateway-responses/${encodeURIComponent(entry.type)}`);
          customized.push(row);
        } catch {
          // A flagged type that no longer resolves is treated as default.
        }
      }
      setState({ status: "ready", types, customizations: customized, error: null });
    } catch (error) {
      setState({ status: "error", types: [], customizations: [], error: error.message });
    }
  }, [project.id, apiRef]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const types = await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/gateway-responses`);
        const customized = [];
        for (const entry of types.filter((type) => type.customized)) {
          try {
            customized.push(await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/gateway-responses/${encodeURIComponent(entry.type)}`));
          } catch {
            // Treated as default (see load).
          }
        }
        if (alive) setState({ status: "ready", types, customizations: customized, error: null });
      } catch (error) {
        if (alive) setState({ status: "error", types: [], customizations: [], error: error.message });
      }
    })();
    return () => { alive = false; };
  }, [project.id, apiRef]);

  const save = async (responseType, input) => {
    const current = state.customizations.find((entry) => entry.responseType === responseType);
    try {
      await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/gateway-responses/${encodeURIComponent(responseType)}`, {
        method: "PUT",
        ...(current ? { headers: { "If-Match": String(current.version) } } : {}),
        body: JSON.stringify(input),
      });
      toast.success(`Customized ${responseType}.`);
      await load();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const reset = async (responseType) => {
    try {
      await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/gateway-responses/${encodeURIComponent(responseType)}`, { method: "DELETE" });
      toast.success(`Reset ${responseType} to the default.`);
      await load();
    } catch (error) {
      toast.error(error.message);
    }
  };

  if (state.status === "loading") return <LoadingArea panel label="Loading gateway responses" />;
  if (state.status === "error") {
    return <Unavailable icon={MessageSquareWarning} title="Gateway responses unavailable" error={state.error} onRetry={load} />;
  }
  return <GatewayResponsesTab
    types={state.types}
    customizations={state.customizations}
    loading={false}
    error={null}
    onSave={save}
    onReset={reset}
    canWrite={canWrite}
  />;
}
