"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Route as RouteIcon, Trash2 } from "lucide-react";
import { EmptyState, SectionCard } from "@geiger/ui/screen-kit";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { fetchApis } from "./api_list";
import { RouteAuthPicker } from "../auth/auth_picker";

const TEST_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function splitKey(routeKey) {
  if (routeKey === "$default") return { method: "ANY", path: "$default" };
  const space = routeKey.indexOf(" ");
  if (space === -1) return { method: "", path: routeKey };
  return { method: routeKey.slice(0, space), path: routeKey.slice(space + 1) };
}

export function RoutesTab({ api }) {
  const { project } = useProject();
  const { can } = useRbac();
  const writable = can("pods.route.write");
  const base = `/${encodeURIComponent(api.publicId ?? api.id)}`;
  const [state, setState] = useState({ status: "loading", routes: [], error: null });
  const [creating, setCreating] = useState(false);
  const [routeKey, setRouteKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [testMethod, setTestMethod] = useState("GET");
  const [testPath, setTestPath] = useState("/");
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [authFor, setAuthFor] = useState(null);

  const refresh = useCallback(async () => {
    setState({ status: "loading", routes: [], error: null });
    try {
      const data = await fetchApis(project.id, `${base}/routes?limit=100`);
      setState({ status: "ready", routes: data.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", routes: [], error: error.message });
    }
  }, [project.id, base]);

  useEffect(() => {
    let alive = true;
    fetchApis(project.id, `${base}/routes?limit=100`).then(
      (data) => { if (alive) setState({ status: "ready", routes: data.items ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", routes: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id, base]);

  const grouped = useMemo(() => {
    const groups = new Map();
    for (const route of state.routes) {
      const { path } = splitKey(route.routeKey);
      if (!groups.has(path)) groups.set(path, []);
      groups.get(path).push(route);
    }
    return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }, [state.routes]);

  const mutate = async (work, success) => {
    setBusy(true);
    try {
      await work();
      toast.success(success);
      await refresh();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const runTest = async (event) => {
    event.preventDefault();
    setTesting(true);
    setTestResult(null);
    try {
      const result = await fetchApis(project.id, `${base}/match`, {
        method: "POST",
        body: JSON.stringify({ method: testMethod, path: testPath }),
      });
      setTestResult(result);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setTesting(false);
    }
  };

  if (state.status === "loading") {
    return <SectionCard><div className="flex justify-center py-10"><LogoLoading /></div></SectionCard>;
  }
  if (state.status === "error") {
    return <SectionCard><EmptyState icon={RouteIcon} title="Routes unavailable" description={state.error} action={<Button variant="outline" onClick={refresh}>Retry</Button>} /></SectionCard>;
  }

  return <div className="space-y-8">
    <SectionCard
      title="Routes"
      description={api.protocol === "WEBSOCKET" ? "Free-form route keys ($connect, $disconnect, custom). Route semantics arrive in S12." : "Grouped by path. Exact method beats ANY; greedy {proxy+} needs the longest prefix."}
      actions={writable ? <Button size="sm" onClick={() => setCreating(true)}><Plus className="size-4" />Route</Button> : null}
    >
      {grouped.length === 0 ? <p className="text-sm text-muted-foreground">No routes yet. Requests return 404 Not Found until a route matches.</p> : null}
      <ul className="divide-y divide-border">
        {grouped.map(([path, routes]) => <li key={path} className="py-4 first:pt-0 last:pb-0">
          <p className="font-mono text-sm font-medium">{path}</p>
          <ul className="mt-2 space-y-2">
            {routes.map((route) => <li key={route.id} className="text-sm">
              <div className="flex flex-wrap items-center gap-3">
                <Badge variant="outline">{splitKey(route.routeKey).method}</Badge>
                <span className="text-xs text-muted-foreground">
                  {route.authorizationType}{route.integrationId ? " · integrated" : " · no integration yet (S04)"}
                </span>
                <span className="ml-auto flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setAuthFor(authFor === route.id ? null : route.id)}>Auth</Button>
                  {writable ? <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => mutate(
                      () => fetchApis(project.id, `${base}/routes/${encodeURIComponent(route.id)}`, { method: "DELETE" }),
                      `Deleted ${route.routeKey}.`,
                    )}
                  ><Trash2 className="size-4" />Delete</Button> : null}
                </span>
              </div>
              {authFor === route.id ? <RouteAuthPicker key={`${route.id}-${route.version}`} api={api} route={route} onSaved={refresh} /> : null}
            </li>)}
          </ul>
        </li>)}
      </ul>
    </SectionCard>
    <SectionCard title="Route tester" description="See which draft route a sample request hits.">
      <form className="flex flex-wrap items-end gap-2" onSubmit={runTest}>
        <div className="space-y-2">
          <Label>Method</Label>
          <Select value={testMethod} onValueChange={setTestMethod}>
            <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent>{TEST_METHODS.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="min-w-48 flex-1 space-y-2">
          <Label htmlFor="route-test-path">Path</Label>
          <Input id="route-test-path" value={testPath} onChange={(event) => setTestPath(event.target.value)} placeholder="/pets/1" className="font-mono" required />
        </div>
        <Button type="submit" disabled={testing}>{testing ? "Testing…" : "Test route"}</Button>
      </form>
      {testResult ? <div className="mt-4 rounded-lg border border-border p-3 font-mono text-xs">
        {testResult.matched
          ? <p>Matched <span className="font-medium">{testResult.routeKey}</span>{Object.keys(testResult.pathParameters ?? {}).length > 0 ? ` with ${JSON.stringify(testResult.pathParameters)}` : ""}</p>
          : <p>No match ({testResult.reason}). Requests here return 404 Not Found.</p>}
      </div> : null}
    </SectionCard>
    <Dialog open={creating} onOpenChange={setCreating}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New route</DialogTitle>
          <DialogDescription>{api.protocol === "WEBSOCKET" ? "Any key, e.g. $connect or sendmessage." : "METHOD and path, e.g. GET /pets/{id} or ANY /{proxy+}."}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => {
          event.preventDefault();
          mutate(
            () => fetchApis(project.id, `${base}/routes`, { method: "POST", body: JSON.stringify({ routeKey: routeKey.trim() }) }),
            `Created ${routeKey.trim()}.`,
          ).then(() => { setCreating(false); setRouteKey(""); });
        }}>
          <div className="space-y-2">
            <Label htmlFor="route-key">Route key</Label>
            <Input id="route-key" value={routeKey} onChange={(event) => setRouteKey(event.target.value)} placeholder={api.protocol === "WEBSOCKET" ? "sendmessage" : "GET /pets/{id}"} className="font-mono" required />
          </div>
          <DialogFooter><Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create route"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>;
}
