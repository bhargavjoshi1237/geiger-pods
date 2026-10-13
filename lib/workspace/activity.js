// Network activity for the topbar's activity line (geiger-events tracks its
// Supabase fetches the same way). Pods screens talk to the management API with
// plain fetch, so the workspace wraps window.fetch once and counts in-flight
// /api/v1 requests: reads draw the loading sweep, writes the saving one.

let activeReads = 0;
let activeWrites = 0;
const listeners = new Set();
const MIN_VISIBLE_MS = 3000;

const INACTIVE_SNAPSHOT = { active: false, loading: false, saving: false };

let cachedSnapshot = INACTIVE_SNAPSHOT;
let visibleUntil = 0;
let hideTimer = null;
let installed = false;

const getSnapshot = () => ({
  active: activeReads + activeWrites > 0 || Date.now() < visibleUntil,
  loading: activeReads > 0,
  saving: activeWrites > 0,
});

function updateSnapshot() {
  const next = getSnapshot();
  if (next.active !== cachedSnapshot.active || next.loading !== cachedSnapshot.loading || next.saving !== cachedSnapshot.saving) {
    cachedSnapshot = next.active ? next : INACTIVE_SNAPSHOT;
  }
  listeners.forEach((listener) => listener());
}

function scheduleHide() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (activeReads + activeWrites > 0) return;
  const remaining = visibleUntil - Date.now();
  if (remaining > 0) {
    hideTimer = setTimeout(() => {
      hideTimer = null;
      updateSnapshot();
    }, remaining);
  }
}

function emit() {
  updateSnapshot();
  scheduleHide();
}

export function subscribeToApiActivity(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getApiActivitySnapshot() {
  return cachedSnapshot;
}

export function getApiActivityServerSnapshot() {
  return INACTIVE_SNAPSHOT;
}

function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input?.url ?? "";
}

function isTracked(input) {
  const url = requestUrl(input);
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.origin === window.location.origin && parsed.pathname.includes("/api/v1/");
  } catch {
    return false;
  }
}

function isWrite(input, init) {
  const method = init?.method || (typeof input === "object" && input !== null && "method" in input ? input.method : "GET");
  return !["GET", "HEAD", "OPTIONS"].includes(String(method).toUpperCase());
}

/** Wraps window.fetch once so management-API calls drive the activity line. */
export function installApiActivityTracking() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    if (!isTracked(input)) return original(input, init);
    const write = isWrite(input, init);
    visibleUntil = Math.max(visibleUntil, Date.now() + MIN_VISIBLE_MS);
    if (write) activeWrites += 1;
    else activeReads += 1;
    emit();
    try {
      return await original(input, init);
    } finally {
      if (write) activeWrites = Math.max(0, activeWrites - 1);
      else activeReads = Math.max(0, activeReads - 1);
      emit();
    }
  };
}
