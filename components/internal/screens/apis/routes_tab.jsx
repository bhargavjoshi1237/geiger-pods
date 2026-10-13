"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Route as RouteIcon, ShieldCheck, Trash2 } from "lucide-react";
import { DataTable, EmptyState, Field, LoadingArea, SectionCard } from "@/components/internal/shared/screen_kit";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { ListPagination, usePagination } from "@/components/internal/shared/pagination";
import { fetchApis } from "./api_list";
import { RouteAuthPicker } from "../auth/auth_picker";

const TEST_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const AUTH_LABEL = { NONE: "None", AWS_IAM: "IAM", JWT: "JWT", CUSTOM: "Custom" };

const PRIMARY = "bg-primary text-primary-foreground hover:bg-primary/90";
const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

const EMPTY_BOX = "flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-surface-card py-10 text-text-secondary";

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
  const websocket = api.protocol === "WEBSOCKET";
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
  const [deleteTarget, setDeleteTarget] = useState(null);

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

  const sorted = useMemo(() => [...state.routes].sort((a, b) => {
    const left = splitKey(a.routeKey);
    const right = splitKey(b.routeKey);
    if (left.path !== right.path) return left.path < right.path ? -1 : 1;
    return left.method < right.method ? -1 : left.method > right.method ? 1 : 0;
  }), [state.routes]);
  const pager = usePagination(sorted);

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
    return <LoadingArea panel label="Loading routes" />;
  }
  if (state.status === "error") {
    return <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={RouteIcon} title="Routes unavailable" description={state.error} action={<Button variant="outline" className={SECONDARY} onClick={refresh}>Retry</Button>} /></div>;
  }

  const authRoute = authFor ? state.routes.find((route) => route.id === authFor) ?? null : null;

  const columns = [
    {
      key: "route",
      header: "Route",
      render: (route) => {
        const { method, path } = splitKey(route.routeKey);
        return websocket
          ? <span className="font-mono text-sm font-medium text-foreground">{route.routeKey}</span>
          : <div className="flex items-center gap-2">
            {method ? <Badge variant="outline" className="w-16 justify-center font-mono text-[11px]">{method}</Badge> : null}
            <span className="font-mono text-sm font-medium text-foreground">{path}</span>
          </div>;
      },
    },
    {
      key: "integration",
      header: "Integration",
      render: (route) => route.integrationId
        ? <span className="font-mono text-xs text-text-secondary">{route.integrationId}</span>
        : <span className="text-xs text-text-tertiary">Not connected</span>,
    },
    {
      key: "auth",
      header: "Authorization",
      render: (route) => <Badge variant="outline">{AUTH_LABEL[route.authorizationType] ?? route.authorizationType}</Badge>,
    },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (route) => <ActionMenu
        label={`Actions for ${route.routeKey}`}
        items={[
          { icon: ShieldCheck, label: "Authorization", onSelect: () => setAuthFor(route.id) },
          writable && { separator: true },
          writable && { icon: Trash2, label: "Delete", destructive: true, disabled: busy, onSelect: () => setDeleteTarget(route) },
        ]}
      />,
    },
  ];

  const emptyText = websocket ? "No routes yet — add $connect, $disconnect or a custom key" : "No routes yet — requests return 404 Not Found until a route matches";

  return <div className="space-y-8">
    <SectionCard
      bare
      title="Routes"
      description={websocket ? "Route keys such as $connect, $disconnect and custom actions selected from each message." : "An exact method beats ANY, and a greedy {proxy+} route needs the longest matching prefix."}
      action={writable ? <Button size="sm" className={PRIMARY} onClick={() => setCreating(true)}><Plus className="size-4" />New Route</Button> : null}
    >
      <div className="space-y-5">
        <DataTable
          columns={columns}
          data={pager.pageItems}
          getRowKey={(route) => route.id}
          empty={writable
            ? <button type="button" onClick={() => setCreating(true)} className={`${EMPTY_BOX} transition-colors hover:border-border-strong hover:text-muted-foreground`}>
              <RouteIcon className="size-6" />
              <p className="text-sm">{emptyText}</p>
            </button>
            : <div className={EMPTY_BOX}>
              <RouteIcon className="size-6" />
              <p className="text-sm">No routes yet</p>
            </div>}
        />
        <ListPagination {...pager} itemLabel="routes" />
      </div>
    </SectionCard>

    <SectionCard bare title="Route tester" description="See which draft route a sample request hits.">
      <form className="flex flex-wrap items-end gap-3" onSubmit={runTest}>
        <Field label="Method">
          <Select value={testMethod} onValueChange={setTestMethod}>
            <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent>{TEST_METHODS.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Path" htmlFor="route-test-path" className="min-w-48 flex-1">
          <Input id="route-test-path" value={testPath} onChange={(event) => setTestPath(event.target.value)} placeholder="/pets/1" className="font-mono" required />
        </Field>
        <Button type="submit" className={PRIMARY} disabled={testing}>{testing ? <Loader2 className="size-4 animate-spin" /> : null}Test Route</Button>
      </form>
      {testResult ? <div className="mt-4 rounded-xl border border-border bg-surface-card px-4 py-3 font-mono text-xs text-text-secondary">
        {testResult.matched
          ? <p>Matched <span className="font-medium text-foreground">{testResult.routeKey}</span>{Object.keys(testResult.pathParameters ?? {}).length > 0 ? ` with ${JSON.stringify(testResult.pathParameters)}` : ""}</p>
          : <p>No match ({testResult.reason}). Requests here return 404 Not Found.</p>}
      </div> : null}
    </SectionCard>

    <Dialog open={creating} onOpenChange={setCreating}>
      <DialogContent className="max-w-xl bg-background">
        <DialogHeader>
          <DialogTitle>New Route</DialogTitle>
          <DialogDescription>{websocket ? "Any key, e.g. $connect or sendmessage." : "METHOD and path, e.g. GET /pets/{id} or ANY /{proxy+}."}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(event) => {
          event.preventDefault();
          mutate(
            () => fetchApis(project.id, `${base}/routes`, { method: "POST", body: JSON.stringify({ routeKey: routeKey.trim() }) }),
            `Created ${routeKey.trim()}.`,
          ).then(() => { setCreating(false); setRouteKey(""); });
        }}>
          <Field label="Route key" htmlFor="route-key">
            <Input id="route-key" value={routeKey} onChange={(event) => setRouteKey(event.target.value)} placeholder={websocket ? "sendmessage" : "GET /pets/{id}"} className="font-mono" required />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" className={SECONDARY} onClick={() => setCreating(false)}>Cancel</Button>
            <Button type="submit" className={PRIMARY} disabled={busy}>{busy ? <Loader2 className="size-4 animate-spin" /> : null}Create Route</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <Dialog open={Boolean(authRoute)} onOpenChange={(open) => { if (!open) setAuthFor(null); }}>
      <DialogContent className="max-w-xl bg-background">
        <DialogHeader>
          <DialogTitle>Route Authorization</DialogTitle>
          <DialogDescription>Who may call <span className="font-mono text-foreground">{authRoute?.routeKey}</span>.</DialogDescription>
        </DialogHeader>
        {authRoute ? <RouteAuthPicker key={`${authRoute.id}-${authRoute.version}`} api={api} route={authRoute} onSaved={() => { setAuthFor(null); refresh(); }} onCancel={() => setAuthFor(null)} /> : null}
      </DialogContent>
    </Dialog>

    <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete route</DialogTitle>
          <DialogDescription>
            Delete <span className="font-mono font-medium text-foreground">{deleteTarget?.routeKey}</span>? It is removed from the draft and can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button
            className="bg-red-500/90 text-white hover:bg-red-500"
            disabled={busy}
            onClick={() => {
              const route = deleteTarget;
              setDeleteTarget(null);
              mutate(
                () => fetchApis(project.id, `${base}/routes/${encodeURIComponent(route.id)}`, { method: "DELETE" }),
                `Deleted ${route.routeKey}.`,
              );
            }}
          ><Trash2 className="size-4" />Delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
