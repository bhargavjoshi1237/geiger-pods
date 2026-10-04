"use client";

import { useState } from "react";
import { CircleUserRound, Home, LogOut, Settings, ShieldCheck, UsersRound, Wallet } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@geiger/ui/avatar";
import { Button } from "@geiger/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@geiger/ui/dropdown-menu";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { dashHref } from "@/lib/workspace/model.mjs";

export function ProfileDropdown({ user }) {
  const [signingOut, setSigningOut] = useState(false);
  const metadata = user.user_metadata ?? {};
  const name = metadata.full_name || metadata.name || user.email?.split("@")[0] || "User";
  const initials = name.split(" ").filter(Boolean).map((part) => part[0]).join("").toUpperCase().slice(0, 2);
  const version = Number(metadata.avatar_version) || 0;
  const providerPicture = user.identities?.map((identity) => identity.identity_data?.avatar_url || identity.identity_data?.picture).find(Boolean);
  const storedPicture = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/pfp/${user.id}/latest.jpg`;
  const picture = version ? `${storedPicture}?v=${version}` : "avatar_version" in metadata ? null : providerPicture || storedPicture;

  const signOut = async () => {
    setSigningOut(true);
    try {
      const { error } = await createClient().auth.signOut();
      if (error) throw error;
      window.location.assign(dashHref("/login"));
    } catch (error) {
      toast.error(error.message || "Could not sign out. Try again.");
      setSigningOut(false);
    }
  };

  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="ghost" size="icon-sm" aria-label="Account menu" className="ml-1 overflow-hidden rounded-full border border-border p-0 transition-colors hover:border-border-strong">
        <Avatar className="size-full">
          {picture && <AvatarImage src={picture} alt={name} />}
          <AvatarFallback className="border-0 bg-surface-card text-[10px] font-semibold text-muted-foreground">{initials}</AvatarFallback>
        </Avatar>
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" sideOffset={8} className="w-72 rounded-xl border-border bg-background p-0 text-foreground shadow-xl">
      <DropdownMenuLabel className="p-4">
        <div className="flex items-center gap-3">
          <Avatar className="size-10 border border-border">
            {picture && <AvatarImage src={picture} alt={name} />}
            <AvatarFallback className="border-0 bg-surface-card text-xs font-semibold text-muted-foreground">{initials}</AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-semibold">{name}</span>
            <span className="truncate text-xs font-normal text-muted-foreground">{user.email}</span>
          </div>
        </div>
      </DropdownMenuLabel>
      <DropdownMenuSeparator className="mx-0" />
      <DropdownMenuGroup className="p-1.5">
        {[
          [Home, "Dashboard", "/org"],
          [CircleUserRound, "Profile", `/profile/${encodeURIComponent(user.id)}`],
          [UsersRound, "Organization settings", "/org"],
          [Wallet, "Billing & plans", "/billing"],
          [Settings, "Settings", "/org/settings"],
          [ShieldCheck, "Security", "/org/security"],
        ].map(([Icon, label, path]) => <DropdownMenuItem key={label} asChild className="gap-2.5 rounded-md px-2.5 py-2 text-muted-foreground focus:bg-surface-active focus:text-foreground">
          <a href={dashHref(path)}><Icon className="size-4" /><span>{label}</span></a>
        </DropdownMenuItem>)}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={signingOut} onSelect={signOut} className="gap-2.5 rounded-md px-2.5 py-2 text-muted-foreground focus:bg-red-500/10 focus:text-red-400">
          <LogOut className="size-4" /><span>{signingOut ? "Signing out…" : "Sign out"}</span>
        </DropdownMenuItem>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}
