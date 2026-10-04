import { WorkspaceShell } from "@/components/internal/workspace/workspace_shell";
import { SidebarProvider } from "@geiger/ui/sidebar";
import { ProjectProvider } from "@/context/project-context";
import { RbacProvider } from "@/context/rbac-context";
import { RouteWorkspaceNav } from "@/context/workspace-nav-context";

export const metadata = { title: "Workspace", robots: { index: false, follow: false } };

export default function ProjectLayout({ children }) {
  return <ProjectProvider><RbacProvider><RouteWorkspaceNav>
    <SidebarProvider className="!flex h-[100dvh] w-full min-w-0 flex-col overflow-hidden bg-background font-sans text-foreground selection:bg-surface-strong" style={{ flexDirection: "column" }}>
      <WorkspaceShell>{children}</WorkspaceShell>
    </SidebarProvider>
  </RouteWorkspaceNav></RbacProvider></ProjectProvider>;
}
