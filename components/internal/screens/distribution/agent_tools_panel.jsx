"use client";

// Agent tools panel: enable MCP tools for a stage, allow-list, MCP URL and a
// client config snippet.
import { useEffect, useState } from "react";
import { Bot, Copy, Loader2, Rocket } from "lucide-react";
import { EmptyState, Field, LoadingArea, SectionCard, SettingRow, SettingsList } from "@/components/internal/shared/screen_kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { Switch } from "@geiger/ui/switch";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { fetchApis } from "../apis/api_list";

const PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";
const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

const HEADER = { title: "MCP tools", description: "Expose a stage as MCP tools over Streamable HTTP. Calls run through the normal pipeline: authorizers, API keys, throttling, WAF and logs all apply." };

function copy(value, what) {
  navigator.clipboard?.writeText(value).then(
    () => toast.success(`${what} copied.`),
    () => toast.error(`Couldn't copy the ${what.toLowerCase()}.`),
  );
}

export function AgentToolsPanel({ api, stages }) {
  const { project } = useProject();
  const { can } = useRbac();
  const apiRef = api.publicId ?? api.id;
  const [stageName, setStageName] = useState(stages?.[0]?.name ?? "");
  const [state, setState] = useState({ status: "loading", config: null, error: null });
  const [allowText, setAllowText] = useState("");
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const canWrite = can("pods.stage.write");

  useEffect(() => {
    if (!stageName) return;
    let alive = true;
    fetchApis(project.id, `/${encodeURIComponent(apiRef)}/stages/${encodeURIComponent(stageName)}/agent-tools`).then(
      (data) => {
        if (!alive) return;
        setState({ status: "ready", config: data.agentTools ?? data, error: null });
        setAllowText(((data.agentTools ?? data)?.allowOperations ?? []).join("\n"));
      },
      (error) => { if (alive) setState({ status: "error", config: null, error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id, apiRef, stageName, reloadKey]);

  const save = async (enabled) => {
    setBusy(true);
    try {
      const allowOperations = allowText.split("\n").map((entry) => entry.trim()).filter(Boolean);
      const saved = await fetchApis(project.id, `/${encodeURIComponent(apiRef)}/stages/${encodeURIComponent(stageName)}/agent-tools`, {
        method: "PUT",
        body: JSON.stringify({ agentTools: { enabled, allowOperations: allowOperations.length > 0 ? allowOperations : null, auth: "passthrough" } }),
      });
      setState({ status: "ready", config: saved.agentTools, error: null });
      toast.success(enabled ? "Agent tools enabled for this stage." : "Agent tools disabled for this stage.");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const invokeBase = typeof window !== "undefined" ? window.location.origin : "";
  const mcpUrl = `${invokeBase}/gw/${encodeURIComponent(apiRef)}/${encodeURIComponent(stageName)}/_mcp`;

  if (!stageName) {
    return <SectionCard bare {...HEADER}>
      <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={Rocket} title="No stages yet" description="Deploy a stage first, then configure agent tools on it." /></div>
    </SectionCard>;
  }
  if (state.status === "loading") return <LoadingArea panel label="Loading agent tools" />;
  if (state.status === "error") {
    return <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={Bot}
      title="Agent tools unavailable"
      description={state.error}
      action={<Button variant="outline" className={SECONDARY} onClick={() => { setState({ status: "loading", config: null, error: null }); setReloadKey((key) => key + 1); }}>Retry</Button>}
    /></div>;
  }

  const enabled = !!state.config?.enabled;
  const snippet = JSON.stringify({ mcpServers: { pods: { url: mcpUrl, headers: { Authorization: "Bearer <token>", "x-api-key": "<key>" } } } }, null, 2);

  return <div className="space-y-8">
    <SectionCard bare {...HEADER} action={enabled ? <Badge variant="success">Enabled</Badge> : <Badge variant="outline">Disabled</Badge>}>
      <div className="space-y-4 rounded-xl border border-border bg-surface-card p-4">
        <SettingsList>
          <SettingRow
            title="Stage"
            description="Agent tools are configured per stage."
            control={<Select value={stageName} onValueChange={(value) => { setStageName(value); setState({ status: "loading", config: null, error: null }); }}>
              <SelectTrigger size="sm" className="w-40 sm:w-48" aria-label="Stage"><SelectValue /></SelectTrigger>
              <SelectContent>{(stages ?? []).map((entry) => <SelectItem key={entry.name} value={entry.name}>{entry.name}</SelectItem>)}</SelectContent>
            </Select>}
          />
          <SettingRow
            title="Serve agent tools"
            description="Answer tools/list and tools/call at this stage's MCP URL."
            control={<Switch id="agent-tools-enabled" aria-label="Serve agent tools" checked={enabled} disabled={!canWrite || busy} onCheckedChange={(value) => save(value === true)} />}
          />
        </SettingsList>
        <div className="space-y-3 border-t border-border pt-4">
          <Field label="Allowed operations" htmlFor="agent-tools-allow" hint="One tool per line, as an operation name or METHOD /path. Leave empty to expose every operation.">
            <Textarea id="agent-tools-allow" value={allowText} onChange={(event) => setAllowText(event.target.value)} rows={4} placeholder={"getPets\nGET /pets/{id}"} className="font-mono text-xs" aria-label="Allowed operations" spellCheck={false} disabled={!canWrite} />
          </Field>
          {canWrite ? <div className="flex justify-end">
            <Button size="sm" className={PRIMARY} disabled={busy} onClick={() => save(enabled)}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Save Allow-List</Button>
          </div> : null}
        </div>
      </div>
    </SectionCard>

    <SectionCard bare title="Connect a client" description="Point any MCP client at the stage URL and pass the same credentials a normal request needs.">
      {enabled ? <div className="space-y-3">
        <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-card px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-text-secondary">MCP URL</p>
            <p className="truncate font-mono text-sm text-foreground">{mcpUrl}</p>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Copy MCP URL" className="text-text-secondary hover:bg-surface-active hover:text-foreground" onClick={() => copy(mcpUrl, "MCP URL")}><Copy className="size-4" /></Button>
        </div>
        <div className="relative rounded-xl border border-border bg-surface-card">
          <Button variant="ghost" size="icon-sm" aria-label="Copy client config" className="absolute right-2 top-2 text-text-secondary hover:bg-surface-active hover:text-foreground" onClick={() => copy(snippet, "Client config")}><Copy className="size-4" /></Button>
          <pre className="overflow-auto p-4 pr-12 font-mono text-xs text-foreground">{snippet}</pre>
        </div>
      </div> : <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={Bot} title="Agent tools are off" description="Turn on agent tools to get the MCP URL and a client config." /></div>}
    </SectionCard>
  </div>;
}
