"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { subscribeToSession } from "@/lib/supabase/session";

const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ status: isSupabaseConfigured() ? "loading" : "unconfigured", user: null, error: null });

  useEffect(() => {
    const client = createClient();
    if (!client) return;
    const session = subscribeToSession(client, setState);
    // Auth broadcasts are scoped to an origin; Dash may run on another port.
    const sync = () => { void session.refresh(); };
    const onVisible = () => {
      if (document.visibilityState === "visible") sync();
    };
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", onVisible);
    sync();
    return () => {
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", onVisible);
      session.unsubscribe();
    };
  }, [attempt]);

  const refresh = useCallback(() => {
    setState({ status: "loading", user: null, error: null });
    setAttempt((value) => value + 1);
  }, []);
  const value = useMemo(() => ({ ...state, refresh }), [state, refresh]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

// Fixed signed-in session for the landing playground; never touches Supabase.
export function PlaygroundSessionProvider({ user, children }) {
  const value = useMemo(() => ({ status: "authenticated", user, error: null, refresh: () => {} }), [user]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession requires SessionProvider");
  return value;
}
