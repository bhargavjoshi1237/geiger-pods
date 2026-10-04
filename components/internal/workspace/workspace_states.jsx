"use client";

import Link from "next/link";
import { AlertCircle, Folder, LockKeyhole, Settings } from "lucide-react";
import { EmptyState } from "@geiger/ui/screen-kit";
import { LogoLoading } from "@geiger/ui/logo-loading";
import { Button } from "@geiger/ui/button";
import { useSession } from "@/context/session-context";
import { useProject } from "@/context/project-context";
import { dashHref } from "@/lib/workspace/model.mjs";

export function LoadingArea({ label = "Loading workspace" }) {
  return <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-5" role="status"><LogoLoading size={80} /><span className="text-sm text-muted-foreground">{label}</span></div>;
}

export function WorkspaceGate({ children, requireProject = true }) {
  const session = useSession();
  const { project, projects, loading, error, refresh } = useProject();
  if (session.status === "unconfigured") return <EmptyState icon={Settings} title="Workspace connection needed" description="Connect this workspace to your Geiger environment to open your shared projects." action={<Button asChild><a href={dashHref("/org")}>Open Geiger dashboard</a></Button>} />;
  if (session.status === "loading") return <LoadingArea label="Checking your Geiger session" />;
  if (session.status === "error") return <EmptyState icon={AlertCircle} title="Your session could not be checked" description={session.error} action={<Button onClick={session.refresh}>Try again</Button>} />;
  if (session.status !== "authenticated") return <EmptyState icon={LockKeyhole} title="Continue with your Geiger account" description="Sign in to Geiger Studio to open your projects here. Pods uses the same account and team access." action={<Button asChild><a href={dashHref("/login?next=pods")}>Sign in to Geiger</a></Button>} />;
  if (loading) return <LoadingArea label="Loading your shared projects" />;
  if (error) return <EmptyState icon={AlertCircle} title="Projects could not be loaded" description={error} action={<Button onClick={refresh}>Try again</Button>} />;
  if (!projects.length) return <EmptyState icon={Folder} title="No projects yet" description="Create a project in Geiger Studio or ask your organization to add you to one. It will appear here with your existing team access." action={<Button asChild><a href={dashHref("/org")}>Manage projects in Geiger</a></Button>} />;
  if (requireProject && !project) return <EmptyState icon={LockKeyhole} title="Project unavailable" description="This project does not exist or you no longer have access to it. Choose an accessible project to continue." action={<Button asChild><Link href="/project">Choose a project</Link></Button>} />;
  return children;
}
