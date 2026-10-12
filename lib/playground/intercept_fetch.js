// While the playground is mounted, answers this app's own same-origin API calls
// (`fetch("/api/...")`) from the in-memory seed instead of the server, for the
// screens that don't go through the Supabase client. Kept identical across repos
// (canonical copy: C:\Pro\docs\superpowers\playground-kit\lib\playground\intercept_fetch.js).
//
//   const restore = interceptFetch([
//     ["GET",  "/api/v1/projects/:projectId/services", ({ params }) => listServices(params.projectId)],
//     ["POST", "/api/v1/projects/:projectId/services", ({ body }) => json(createService(body), 201)],
//   ], { basePath: "/pods" });
//
// A handler returns plain data (sent as 200 JSON), `json(data, status)`, a
// `Response`, or undefined (204). Unmatched same-origin `/api/*` calls get a 503
// and a console warning, so gaps show up in the click-through instead of hitting
// the real server with a fake session.

let originalFetch = null;
let tables = [];

export function json(data, status = 200, headers = {}) {
  return new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function compile(pattern) {
  const keys = [];
  const source = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\/:(\w+)/g, (_, key) => {
      keys.push(key);
      return "/([^/]+)";
    })
    .replace(/\/\*$/, "(?:/(.*))?");
  return { regex: new RegExp(`^${source}/?$`), keys };
}

function normalizeRoutes(routes) {
  return routes.map((route) => {
    const [method, pattern, handler] = Array.isArray(route)
      ? route
      : [route.method, route.path, route.handler];
    return { method: String(method).toUpperCase(), pattern, handler, ...compile(pattern) };
  });
}

async function readBody(request) {
  const type = request.headers.get("content-type") || "";
  if (request.method === "GET" || request.method === "HEAD") return null;
  if (type.includes("application/json")) return request.json().catch(() => null);
  if (type.includes("form")) return request.formData().catch(() => null);
  const text = await request.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toResponse(out) {
  if (out instanceof Response) return out;
  if (out === undefined) return new Response(null, { status: 204 });
  return json(out);
}

async function playgroundFetch(input, init) {
  const request = new Request(input, init);
  const url = new URL(request.url, window.location.href);
  if (url.origin !== window.location.origin) return originalFetch.call(window, input, init);

  let unhandledPath = null;
  for (const table of tables) {
    const path = table.basePath && url.pathname.startsWith(table.basePath)
      ? url.pathname.slice(table.basePath.length) || "/"
      : url.pathname;

    for (const route of table.routes) {
      if (route.method !== request.method && !(route.method === "GET" && request.method === "HEAD")) continue;
      const match = path.match(route.regex);
      if (!match) continue;
      const params = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
      if (match.length > route.keys.length + 1) params.rest = match[route.keys.length + 1] ?? "";
      const query = Object.fromEntries(url.searchParams.entries());
      try {
        const body = await readBody(request);
        if (table.latency) await new Promise((resolve) => setTimeout(resolve, table.latency));
        return toResponse(await route.handler({ params, query, body, request, url }));
      } catch (e) {
        console.error(`[playground] ${request.method} ${path} failed`, e);
        return json({ error: e?.message || "Playground handler failed" }, 500);
      }
    }

    if (path.startsWith("/api/")) unhandledPath ??= path;
  }

  if (unhandledPath) {
    console.warn(`[playground] unhandled ${request.method} ${unhandledPath}`);
    return json({ error: "Not available in the playground" }, 503);
  }

  return originalFetch.call(window, input, init);
}

/** Start answering same-origin API calls from `routes`; returns `restore()`. */
export function interceptFetch(routes, { basePath = "", latency = 60 } = {}) {
  if (typeof window === "undefined") return () => {};
  const table = { routes: normalizeRoutes(routes), basePath: basePath.replace(/\/$/, ""), latency };
  tables = [...tables, table];
  if (!originalFetch) {
    originalFetch = window.fetch;
    window.fetch = playgroundFetch;
  }
  return () => {
    tables = tables.filter((t) => t !== table);
    if (tables.length === 0 && originalFetch) {
      window.fetch = originalFetch;
      originalFetch = null;
    }
  };
}
