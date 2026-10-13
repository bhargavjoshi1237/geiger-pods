"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
  getApiActivityServerSnapshot,
  getApiActivitySnapshot,
  installApiActivityTracking,
  subscribeToApiActivity,
} from "@/lib/workspace/activity";

// The hairline sweep under the topbar while data loads or saves (geiger-events' SupabaseActivityLine).
export function ActivityLine() {
  useEffect(() => {
    installApiActivityTracking();
  }, []);
  const activity = useSyncExternalStore(
    subscribeToApiActivity,
    getApiActivitySnapshot,
    getApiActivityServerSnapshot,
  );

  if (!activity.active) {
    return null;
  }

  return (
    <div
      aria-label={activity.saving ? "Saving changes" : "Loading data"}
      aria-live="polite"
      className="pointer-events-none absolute inset-x-0 -bottom-px h-px overflow-hidden"
      role="status"
    >
      <div
        className={[
          "supabase-activity-line",
          activity.saving ? "is-saving" : "is-loading",
        ].join(" ")}
      />
    </div>
  );
}
