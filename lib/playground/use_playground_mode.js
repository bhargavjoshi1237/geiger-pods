"use client";

import { useLayoutEffect } from "react";

import { enterPlayground } from "./mode";
import { interceptFetch } from "./intercept_fetch";

// One live playground session per document: the mode switch plus, when the app
// has API routes to fake, the fetch interceptor.
let session = null;

function activate(handlers, routes, basePath) {
  if (typeof window === "undefined") return;
  if (session && session.handlers === handlers && session.routes === routes) return;
  session?.exit();
  const exitMode = enterPlayground(handlers);
  const restoreFetch = routes ? interceptFetch(routes, { basePath }) : null;
  session = {
    handlers,
    routes,
    exit() {
      restoreFetch?.();
      exitMode();
    },
  };
}

function deactivate() {
  session?.exit();
  session = null;
}

// Switched on during render, before any child renders, so a screen that builds
// its client in render (`useState(() => createClient())`) still gets the
// in-memory one; re-asserted in a layout effect (which also covers React's
// strict-mode remount) and switched off on unmount.
//
// `handlers` and `routes` must be module-level constants so their identity is
// stable across renders.
export function usePlaygroundMode(handlers, { routes = null, basePath = "" } = {}) {
  activate(handlers, routes, basePath);
  useLayoutEffect(() => {
    activate(handlers, routes, basePath);
    return deactivate;
  }, [handlers, routes, basePath]);
}
