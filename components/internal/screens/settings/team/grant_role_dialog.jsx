"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Field } from "@/components/internal/shared/screen_kit";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { toast } from "sonner";
import { SYSTEM_ROLES } from "./team_model";

const CUSTOM_ROLE = "__custom";
const ROLE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

export function GrantRoleDialog({ open, onOpenChange, onSubmit, busy, initialUserId = "" }) {
  // Keyed by `open` in the parent, so the form starts fresh every time.
  const [userId, setUserId] = useState(initialUserId);
  const [roleChoice, setRoleChoice] = useState("member");
  const [customRole, setCustomRole] = useState("");
  const [apis, setApis] = useState("");

  const submit = () => {
    const roleKey = roleChoice === CUSTOM_ROLE ? customRole.trim() : roleChoice;
    if (!userId.trim()) {
      toast.error("Enter the teammate's user ID first.");
      return;
    }
    if (!ROLE_KEY_PATTERN.test(roleKey)) {
      toast.error("Role keys are lowercase letters, digits and underscores, starting with a letter.");
      return;
    }
    const apiIds = apis.split(",").map((entry) => entry.trim()).filter(Boolean);
    onSubmit({
      userId: userId.trim(),
      roleKey,
      ...(apiIds.length > 0 ? { scope: { api: apiIds } } : {}),
    });
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-xl bg-background">
      <DialogHeader>
        <DialogTitle>Grant Role</DialogTitle>
        <DialogDescription>Give a teammate a product role. You can never grant a role holding a permission you lack yourself.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <Field label="User ID" htmlFor="grant-user">
          <Input id="grant-user" autoFocus={!initialUserId} value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="00000000-0000-4000-8000-000000000000" spellCheck={false} className="font-mono text-xs" />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Role" htmlFor="grant-role">
            <Select value={roleChoice} onValueChange={setRoleChoice}>
              <SelectTrigger id="grant-role" className="w-full"><SelectValue placeholder="Select role" /></SelectTrigger>
              <SelectContent>
                {SYSTEM_ROLES.map((role) => <SelectItem key={role.key} value={role.key}>{role.name}</SelectItem>)}
                <SelectItem value={CUSTOM_ROLE}>Custom role…</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {roleChoice === CUSTOM_ROLE ? <Field label="Role key" htmlFor="grant-role-key">
            <Input id="grant-role-key" value={customRole} onChange={(event) => setCustomRole(event.target.value)} placeholder="api_developer" spellCheck={false} className="font-mono text-xs" />
          </Field> : <div />}
        </div>
        {roleChoice !== CUSTOM_ROLE ? <p className="-mt-2 text-xs text-text-secondary">{SYSTEM_ROLES.find((role) => role.key === roleChoice)?.description}</p> : null}
        <Field label="API IDs (optional)" htmlFor="grant-apis" hint="Comma-separated. Leave empty to grant the role on every API in the project.">
          <Input id="grant-apis" value={apis} onChange={(event) => setApis(event.target.value)} placeholder="a1b2c3d4e5, f6g7h8i9j0" spellCheck={false} className="font-mono text-xs" />
        </Field>
      </div>
      <DialogFooter>
        <Button variant="outline" className="border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button className="bg-primary text-primary-foreground hover:bg-primary/90" disabled={busy} onClick={submit}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Grant Role
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
