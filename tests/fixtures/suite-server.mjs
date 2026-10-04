// Local browser verification only. Never loaded by the application.
import { createServer } from "node:http";

const userId = "00000000-0000-4000-8000-000000000001";
const user = { id: userId, aud: "authenticated", role: "authenticated", email: "fixture@example.test", app_metadata: {}, user_metadata: { name: "Fixture account" }, created_at: "2026-10-04T00:00:00Z" };
const expiresAt = Math.floor(Date.now() / 1000) + 86400;
const token = [Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"), Buffer.from(JSON.stringify({ sub: userId, aud: "authenticated", exp: expiresAt })).toString("base64url"), "local-fixture-signature"].join(".");
const session = { access_token: token, refresh_token: "local-fixture-refresh", token_type: "bearer", expires_in: 86400, expires_at: expiresAt, user };
const cookie = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
let role = "owner";
let failProjects = false;
const projects = [
  { id: "project-alpha", name: "Alpha services", slug: "alpha-services", organization_id: "org-a", created_by: userId, status: "active", created_at: "2026-10-01T00:00:00Z" },
  { id: "project-beta", name: "Beta platform", slug: "beta-platform", organization_id: "org-a", created_by: userId, status: "active", created_at: "2026-10-02T00:00:00Z" },
  { id: "project-forbidden", name: "Inaccessible project", organization_id: "org-other", created_by: userId, status: "active" },
];

const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost:3010");
  response.setHeader("Access-Control-Allow-Origin", "http://localhost:3008");
  response.setHeader("Access-Control-Allow-Headers", "authorization, apikey, content-type, x-client-info, accept-profile, content-profile, prefer, x-supabase-api-version");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
  const json = (status, value) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
  if (url.pathname === "/fixture") {
    role = url.searchParams.get("role") === "member" ? "member" : "owner";
    failProjects = url.searchParams.get("fail") === "true";
    response.setHeader("Set-Cookie", `sb-localhost-auth-token=${url.searchParams.has("clear") ? "" : cookie}; Path=/; SameSite=Lax${url.searchParams.has("clear") ? "; Max-Age=0" : ""}`);
    response.writeHead(302, { Location: "http://localhost:3008/project" }); response.end(); return;
  }
  if (url.pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end('<!doctype html><html><title>Isolated Geiger session fixture</title><body><h1>Local verification fixture</h1><p>Fake account and projects; no production database connection.</p><p><a href="/fixture">Open owner fixture</a></p><p><a href="/fixture?role=member">Open member fixture</a></p><p><a href="/fixture?fail=true">Open project error fixture</a></p><p><a href="/fixture?clear=true">Clear fixture session</a></p></body></html>'); return;
  }
  if (request.headers.authorization !== `Bearer ${token}`) { json(401, { message: "Invalid fixture token" }); return; }
  if (url.pathname === "/auth/v1/user") { json(200, user); return; }
  if (url.pathname === "/rest/v1/projects") { json(failProjects ? 503 : 200, failProjects ? { message: "Fixture project lookup unavailable" } : projects); return; }
  if (url.pathname === "/rest/v1/organization_users") { json(200, [{ organization: "org-a", user: userId, role }]); return; }
  json(404, { message: "Unknown fixture endpoint" });
});
server.listen(3010, "localhost", () => process.stdout.write("Isolated suite fixture: http://localhost:3010\n"));
