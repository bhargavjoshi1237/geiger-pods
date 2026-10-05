export const LAST_PROJECT_KEY = "geiger-pods:last-project";
import { SECTIONS } from "./screens.mjs";

export { SECTIONS };

export function pickDefaultProjectId(projects, remembered) {
  return projects.find((p) => p.id === remembered)?.id ?? projects[0]?.id ?? null;
}

export function resolveSection(rest) {
  if (!rest?.length) return "overview";
  return rest.length === 1 && SECTIONS.includes(rest[0]) ? rest[0] : null;
}

export function productHref(path, basePath = process.env.NEXT_PUBLIC_BASE_PATH || "") {
  return `${basePath}${path === "/" ? "" : path}` || "/";
}

export function dashHref(path, origin = process.env.NEXT_PUBLIC_DASH_URL || "") {
  return `${origin.replace(/\/$/, "")}${path}`;
}

export function suiteCookieOptions(domain, production) {
  return { domain: domain || undefined, path: "/", sameSite: "lax", secure: production };
}
