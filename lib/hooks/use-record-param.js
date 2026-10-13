"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { useWorkspaceNav } from "@/context/workspace-nav-context";

// The record a list screen has open, kept in a `?record=` query param the way
// geiger-events opens a record's edit page in place: pushState keeps the list
// screen mounted (no route transition, nothing flashes), and back/forward
// close and reopen the record. The landing playground keeps it in state.

const CHANGE_EVENT = "pods:query-change";

function subscribe(listener) {
  window.addEventListener("popstate", listener);
  window.addEventListener(CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(CHANGE_EVENT, listener);
  };
}

function readParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function writeParam(name, value, { replace = false } = {}) {
  const url = new URL(window.location.href);
  if (value === null || value === undefined || value === "") url.searchParams.delete(name);
  else url.searchParams.set(name, String(value));
  const href = `${url.pathname}${url.search}${url.hash}`;
  if (replace) window.history.replaceState(window.history.state, "", href);
  else window.history.pushState(window.history.state, "", href);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * @param {string} [name="record"] - Query param name.
 * @returns {[string|null, (value: string|null, options?: { replace?: boolean }) => void]}
 */
export function useRecordParam(name = "record") {
  const { memory } = useWorkspaceNav();
  const [local, setLocal] = useState(null);
  const fromUrl = useSyncExternalStore(
    subscribe,
    () => readParam(name),
    () => null,
  );
  const set = useCallback((value, options) => {
    if (memory) setLocal(value ?? null);
    else writeParam(name, value, options);
  }, [memory, name]);
  return [memory ? local : fromUrl, set];
}
