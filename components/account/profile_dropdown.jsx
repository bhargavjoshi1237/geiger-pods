"use client";

import { useState } from "react";
import { useTheme } from "next-themes";
import {
  BookMarked,
  CircleUserRound,
  ExternalLink,
  LifeBuoy,
  LogOut,
  MessageCircle,
  Moon,
  Settings,
  ShieldCheck,
  Sun,
  UsersRound,
  Wallet,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@geiger/ui/avatar";
import { Button } from "@geiger/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@geiger/ui/dropdown-menu";
import { ToggleGroup, ToggleGroupItem } from "@geiger/ui/toggle-group";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { dashHref } from "@/lib/workspace/model.mjs";

// The suite account menu, laid out item-for-item like geiger-events'. Account
// destinations live in geiger-dash, so every link goes through dashHref.

const itemBaseStyle =
  "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm cursor-default transition-colors outline-none";

const itemHoverStyle =
  "hover:bg-surface-active focus:bg-surface-active text-muted-foreground hover:text-foreground focus:text-foreground";

export function ProfileDropdown({ user }) {
  const [signingOut, setSigningOut] = useState(false);
  const { theme, setTheme } = useTheme();
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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Account menu"
          className="p-0 rounded-full border border-border hover:border-border-strong overflow-hidden ml-1 transition-colors"
        >
          <Avatar className="size-full">
            {picture && <AvatarImage src={picture} alt={name} />}
            <AvatarFallback className="bg-surface-card text-muted-foreground text-[10px] font-semibold border-0">
              {initials}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        className="w-72 p-0 rounded-xl border border-border bg-background text-foreground shadow-xl"
        sideOffset={8}
        align="end"
      >
        <div className="p-4 pb-3">
          <DropdownMenuLabel className="p-0">
            <div className="flex items-center gap-3">
              <Avatar className="size-10 border border-border">
                {picture && <AvatarImage src={picture} alt={name} />}
                <AvatarFallback className="bg-surface-card text-muted-foreground text-xs font-semibold border-0">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div className="flex flex-col min-w-0 flex-1">
                <span className="text-sm font-semibold text-foreground truncate">{name}</span>
                <span className="text-xs text-muted-foreground truncate">{user.email}</span>
              </div>
            </div>
          </DropdownMenuLabel>
        </div>

        <DropdownMenuSeparator className="bg-surface-hover mx-0" />

        <div className="p-1.5">
          <DropdownMenuGroup>
            <DropdownMenuItem asChild className={`${itemBaseStyle} ${itemHoverStyle}`}>
              <a href={dashHref(`/profile/${encodeURIComponent(user.id)}`)}>
                <CircleUserRound className="size-4 text-muted-foreground" />
                <span>Profile</span>
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem asChild className={`${itemBaseStyle} ${itemHoverStyle}`}>
              <a href={dashHref("/org/")}>
                <UsersRound className="size-4 text-muted-foreground" />
                <span>Organization Settings</span>
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem asChild className={`${itemBaseStyle} ${itemHoverStyle}`}>
              <a href={dashHref("/billing")}>
                <Wallet className="size-4 text-muted-foreground" />
                <span>Billing &amp; Plans</span>
              </a>
            </DropdownMenuItem>
          </DropdownMenuGroup>

          <DropdownMenuSeparator className="bg-surface-hover my-1" />

          <DropdownMenuGroup>
            <DropdownMenuItem asChild className={`${itemBaseStyle} ${itemHoverStyle}`}>
              <a href={dashHref("/org/settings")}>
                <Settings className="size-4 text-muted-foreground" />
                <span>Settings</span>
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem asChild className={`${itemBaseStyle} ${itemHoverStyle}`}>
              <a href={dashHref("/org/security")}>
                <ShieldCheck className="size-4 text-muted-foreground" />
                <span>Security</span>
              </a>
            </DropdownMenuItem>
          </DropdownMenuGroup>

          <DropdownMenuSeparator className="bg-surface-hover my-1" />

          <DropdownMenuGroup>
            <DropdownMenuItem asChild className={`${itemBaseStyle} ${itemHoverStyle}`}>
              <a href="mailto:feedback@geiger.studio">
                <MessageCircle className="size-4 text-muted-foreground" />
                <span>Send Feedback</span>
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem asChild className={`${itemBaseStyle} ${itemHoverStyle}`}>
              <a href="mailto:help@geiger.studio">
                <LifeBuoy className="size-4 text-muted-foreground" />
                <span>Help &amp; Support</span>
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem asChild className={`${itemBaseStyle} ${itemHoverStyle} mb-1`}>
              <a href={dashHref("/doc")}>
                <BookMarked className="size-4 text-muted-foreground" />
                <span>Documentation</span>
                <ExternalLink className="size-3 ml-auto text-text-secondary" />
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={signingOut}
              onSelect={signOut}
              className={`${itemBaseStyle} text-muted-foreground hover:bg-red-500/10 focus:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400 focus:text-red-600 dark:focus:text-red-400 group`}
            >
              <LogOut className="size-4 group-hover:text-red-600 dark:group-hover:text-red-400 group-focus:text-red-600 dark:group-focus:text-red-400" />
              <span>{signingOut ? "Signing out…" : "Sign out"}</span>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </div>

        <div className="px-3 py-2.5 border-t border-border flex items-center justify-between">
          <span className="text-[13px] font-medium text-muted-foreground">Theme</span>
          <ToggleGroup
            type="single"
            value={theme}
            onValueChange={(value) => {
              if (value) setTheme(value);
            }}
            className="bg-surface-subtle border border-border flex items-center rounded-lg p-0.5"
          >
            <ToggleGroupItem
              value="light"
              aria-label="Light theme"
              className="data-[state=on]:bg-surface-active data-[state=on]:text-foreground text-muted-foreground rounded-md hover:bg-surface-card hover:text-foreground px-3 h-7 text-xs gap-1.5 justify-center"
            >
              <Sun className="size-3.5" />
            </ToggleGroupItem>
            <ToggleGroupItem
              value="dark"
              aria-label="Dark theme"
              className="data-[state=on]:bg-surface-active data-[state=on]:text-foreground text-muted-foreground rounded-md hover:bg-surface-card hover:text-foreground px-3 h-7 text-xs gap-1.5 justify-center"
            >
              <Moon className="size-3.5" />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
