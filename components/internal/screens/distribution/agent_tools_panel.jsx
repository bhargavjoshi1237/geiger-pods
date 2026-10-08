"use client";

// Agent tools panel (S13 part E): enable MCP tools for a stage, allow-list,
// MCP URL and a client config snippet.
import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { fetchApis } from "../apis/api_list";

export function AgentToolsPanel({ api, stages }) {
  const { project } = useProject();
  const { can } = useRbac();
  const apiRef = api.publicId ?? api.id;
  const [stageName, setStageName] = useState(stages?.[0]?.name ?? "");
  const [state, setState] = useState({ status: "loading", config: null, error: null });
  const [allowText, setAllowText] = useState("");
  const [busy, setBusy] = useState(false);
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
  }, [project.id, apiRef, stageName]);

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
    return (
      <div className="space-y-4">
        <ScreenHeader title="Agent tools" description="Expose this stage as MCP tools (Streamable HTTP). Calls run through the normal pipeline: authorizers, keys, throttling, WAF and logs all apply." />
        <SectionCard><p className="text-sm text-muted-foreground">Deploy a stage first, then configure agent tools on it.</p></SectionCard>
      </div>
    );
  }
  if (state.status === "loading") return <SectionCard><div className="flex justify-center py-10"><LogoLoading /></div></SectionCard>;
  if (state.status === "error") {
    return <SectionCard><EmptyState icon={Bot} title="Agent tools unavailable" description={state.error} /></SectionCard>;
  }

  return (
    <div className="space-y-4">
      <ScreenHeader title="Agent tools" description="Expose this stage as MCP tools (Streamable HTTP). Calls run through the normal pipeline: authorizers, keys, throttling, WAF and logs all apply." />
      <SectionCard>
        <div className="flex flex-wrap items-center gap-2">
          <select value={stageName} onChange={(event) => { setStageName(event.target.value); setState({ status: "loading", config: null, error: null }); }} className="rounded-md border border-border bg-background px-2 py-1 text-sm" aria-label="Stage">
            {(stages ?? []).map((entry) => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
          </select>
          {canWrite ? (
            <>
              <Button disabled={busy || !stageName} onClick={() => save(true)}>Enable</Button>
              <Button variant="outline" disabled={busy || !stageName} onClick={() => save(false)}>Disable</Button>
            </>
          ) : null}
        </div>
        <textarea value={allowText} onChange={(event) => setAllowText(event.target.value)} rows={4} placeholder={"One tool per line (operationName or METHOD /path). Empty = all operations."} className="mt-2 w-full rounded-md border border-border bg-background p-2 font-mono text-xs" aria-label="Allowed operations" />
        {state.config?.enabled ? (
          <div className="mt-2 space-y-2 text-sm">
            <p className="font-mono text-xs">MCP URL: {mcpUrl}</p>
            <pre className="overflow-auto rounded bg-muted p-2 font-mono text-xs">{JSON.stringify({ mcpServers: { pods: { url: mcpUrl, headers: { Authorization: "Bearer <token>", "x-api-key": "<key>" } } } }, null, 2)}</pre>
          </div>
        ) : <p className="mt-2 text-sm text-muted-foreground">Disabled. Enable to serve tools/list + tools/call at the MCP URL.</p>}
      </SectionCard>
    </div>
  );
}
