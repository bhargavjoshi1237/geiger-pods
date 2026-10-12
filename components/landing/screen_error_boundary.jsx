"use client";

import React from "react";
import { TriangleAlert } from "lucide-react";
import { EmptyState, SectionCard } from "@geiger/ui/screen-kit";

// The playground runs the real workspace screens on the public landing page, so
// one screen tripping over unexpected data must not take the page down with it.
// Give it a `key` (the screen path) so switching screens resets it.
export class ScreenErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error("[playground] screen failed to render", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="mx-auto w-full space-y-8 px-2 py-4 lg:max-w-[85%] lg:px-0">
      <SectionCard>
        <EmptyState
          icon={TriangleAlert}
          title="This screen couldn't load in the playground"
          description="Pick another screen from the sidebar, or open the workspace to see this one with your own data."
        />
      </SectionCard>
    </div>;
  }
}

export default ScreenErrorBoundary;
