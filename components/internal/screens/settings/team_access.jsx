"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, LockKeyhole, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { EmptyState, LoadingArea, ScreenHeader, StatsBar } from "@/components/internal/shared/screen_kit";
import { MainScreenWrapper } from "@/components/internal/shared/screen_wrappers";
import { Notice, ScreenTabs } from "@/components/internal/shared/settings_screen";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { api, membersFromGrants, roleLabel, scopedApis } from "./team/team_model";
import { GrantRoleDialog } from "./team/grant_role_dialog";
import { MembersTab } from "./team/members_tab";
import { GrantsTab } from "./team/grants_tab";
import { ActivityTab } from "./team/activity_tab";
import { MemberDrawer } from "./team/member_drawer";

// Settings → Team & Access, laid out like geiger-events' Team & Members: stats,
// then Members / Grants / Activity tabs. The roster is derived from product
// role grants — everyone else inherits access from their Geiger team role.

export function TeamAccessScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", items: [], error: null });
  const [activity, setActivity] = useState({ status: "idle", items: [], error: null });
  const [tab, setTab] = useState("members");
  const [granting, setGranting] = useState(null);
  const [busy, setBusy] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [openUserId, setOpenUserId] = useState(null);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [accessFilter, setAccessFilter] = useState("all");
  const manageable = can("pods.role.grant");
  const auditable = can("pods.audit.view");

  const refresh = useCallback(async () => {
    try {
      const data = await api(project.id, "/role-grants");
      setState({ status: "ready", items: data.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", items: [], error: error.message });
    }
  }, [project.id]);

  const loadActivity = useCallback(async () => {
    setActivity({ status: "loading", items: [], error: null });
    try {
      const data = await api(project.id, "/audit?resourceType=role_grant&limit=100");
      setActivity({ status: "ready", items: data.items ?? [], error: null });
    } catch (error) {
      setActivity({ status: "error", items: [], error: error.message });
    }
  }, [project.id]);

  useEffect(() => {
    if (!manageable) return undefined;
    let alive = true;
    api(project.id, "/role-grants").then(
      (data) => { if (alive) setState({ status: "ready", items: data.items ?? [], error: null }); },
      (error) => { if (alive) setState({ status: "error", items: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id, manageable]);

  // Activity loads the first time its tab opens, and again after each write.
  const showTab = (key) => {
    setTab(key);
    if (key === "activity" && activity.status === "idle") loadActivity();
  };

  const grants = state.items;
  const members = useMemo(() => membersFromGrants(grants), [grants]);
  const openMember = members.find((member) => member.userId === openUserId) ?? null;

  const roleOptions = useMemo(() => {
    const seen = new Map();
    for (const grant of grants) if (grant.roleKey && !seen.has(grant.roleKey)) seen.set(grant.roleKey, roleLabel(grant));
    return [{ value: "all", label: "All Roles" }, ...[...seen].map(([value, label]) => ({ value, label }))];
  }, [grants]);

  const query = search.trim().toLowerCase();

  const filteredGrants = useMemo(() => grants.filter((grant) => {
    if (roleFilter !== "all" && grant.roleKey !== roleFilter) return false;
    const scoped = scopedApis(grant).length > 0;
    if (accessFilter === "project" && scoped) return false;
    if (accessFilter === "scoped" && !scoped) return false;
    return !query || `${grant.userId} ${grant.roleKey ?? ""} ${grant.roleName ?? ""} ${scopedApis(grant).join(" ")}`.toLowerCase().includes(query);
  }), [grants, query, roleFilter, accessFilter]);

  const filteredMembers = useMemo(() => members.filter((member) => {
    if (roleFilter !== "all" && !member.grants.some((grant) => grant.roleKey === roleFilter)) return false;
    return !query || `${member.userId} ${member.grants.map((grant) => `${grant.roleKey ?? ""} ${grant.roleName ?? ""}`).join(" ")}`.toLowerCase().includes(query);
  }), [members, query, roleFilter]);

  const stats = useMemo(() => [
    { label: "Members", value: String(members.length), footer: "With a product grant" },
    { label: "Grants", value: String(grants.length), footer: "Product roles in force" },
    { label: "Scoped", value: String(grants.filter((grant) => scopedApis(grant).length > 0).length), footer: "Narrowed to specific APIs" },
    { label: "Roles in use", value: String(new Set(grants.map((grant) => grant.roleKey)).size), footer: "Distinct roles granted" },
  ], [grants, members]);

  const afterWrite = async () => {
    await refresh();
    if (activity.status !== "idle") loadActivity();
  };

  const grant = async (body) => {
    setBusy(true);
    try {
      await api(project.id, "/role-grants", { method: "POST", body: JSON.stringify(body) });
      toast.success("Role granted.");
      setGranting(null);
      await afterWrite();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    const target = revokeTarget;
    if (!target) return;
    setBusy(true);
    try {
      await api(project.id, `/role-grants?id=${encodeURIComponent(target.id)}`, { method: "DELETE" });
      toast.success("Grant revoked.");
      setRevokeTarget(null);
      await afterWrite();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  if (!manageable) {
    return <MainScreenWrapper>
      <ScreenHeader title="Team & Access" description="Product roles for the people working in this project." />
      <div className="rounded-xl border border-border bg-surface-subtle">
        <EmptyState icon={LockKeyhole} title="Access unavailable" description="Managing product roles needs the Grant product roles permission." />
      </div>
    </MainScreenWrapper>;
  }

  const grantButton = <Button className="bg-primary text-primary-foreground hover:bg-primary/90" onClick={() => setGranting({ userId: "" })}>
    <UserPlus className="h-4 w-4" /> Grant Role
  </Button>;

  const tabs = [
    { key: "members", label: "Members", count: members.length },
    { key: "grants", label: "Grants", count: grants.length },
    ...(auditable ? [{ key: "activity", label: "Activity" }] : []),
  ];

  const filterProps = { search, setSearch, roleFilter, setRoleFilter, roleOptions, emptyAction: grantButton };

  return <MainScreenWrapper>
    <ScreenHeader
      title="Team & Access"
      description="Grant product roles to teammates. Everyone else inherits access from their Geiger team role."
      actions={grantButton}
    />

    <StatsBar stats={stats} />

    <Notice>
      A product role adds to — or, scoped to specific APIs, narrows — what a teammate&apos;s Geiger team role already allows. You can only grant roles whose permissions you hold yourself.
    </Notice>

    <ScreenTabs tabs={tabs} value={tab} onValueChange={showTab} />

    {tab === "activity" ? <ActivityTab state={activity} onRetry={loadActivity} /> : null}
    {tab !== "activity" && state.status === "loading" ? <LoadingArea panel label="Loading role grants" /> : null}
    {tab !== "activity" && state.status === "error" ? <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={ShieldCheck}
      title="Grants unavailable"
      description={state.error}
      action={<Button variant="outline" onClick={() => { setState({ status: "loading", items: [], error: null }); refresh(); }}>Retry</Button>}
    /></div> : null}
    {state.status === "ready" && tab === "members" ? <MembersTab
      {...filterProps}
      members={filteredMembers}
      total={members.length}
      onOpen={(member) => setOpenUserId(member.userId)}
      onGrant={(userId) => setGranting({ userId })}
    /> : null}
    {state.status === "ready" && tab === "grants" ? <GrantsTab
      {...filterProps}
      grants={filteredGrants}
      total={grants.length}
      accessFilter={accessFilter}
      setAccessFilter={setAccessFilter}
      onRevoke={setRevokeTarget}
    /> : null}

    <MemberDrawer
      member={openMember}
      onOpenChange={(open) => { if (!open) setOpenUserId(null); }}
      onGrant={(userId) => setGranting({ userId })}
      onRevoke={setRevokeTarget}
    />

    <GrantRoleDialog
      key={granting ? `grant-open-${granting.userId}` : "grant-closed"}
      open={!!granting}
      onOpenChange={(open) => { if (!open) setGranting(null); }}
      initialUserId={granting?.userId ?? ""}
      onSubmit={grant}
      busy={busy}
    />

    <Dialog open={!!revokeTarget} onOpenChange={(open) => { if (!open) setRevokeTarget(null); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Revoke role</DialogTitle>
          <DialogDescription>
            Revoke <span className="font-medium text-foreground">{revokeTarget ? roleLabel(revokeTarget) : ""}</span> from <span className="font-mono text-xs text-foreground">{revokeTarget?.userId}</span>? They fall back to their inherited Geiger access immediately.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setRevokeTarget(null)}>Cancel</Button>
          <Button className="bg-red-500/90 text-white hover:bg-red-500" disabled={busy} onClick={revoke}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Revoke
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </MainScreenWrapper>;
}
