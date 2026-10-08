import { notFound } from "next/navigation";
import { sanitizeMarkdown } from "@/lib/gateway/distribution/portals.mjs";
import { resolvePublishedPortalView } from "@/lib/control/portals.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The public portal serves only the frozen published snapshot (never draft
// tables). For `access.mode === "authenticated"` the viewer must be signed
// in through the suite Supabase session and pass the portal's
// allowed-email-domain filter (`checkPortalAccess`); anonymous visitors see a
// sign-in prompt and disallowed domains see a denied page, both with no
// snapshot content in the HTML.
async function loadView(slug) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return { error: { status: 404 } };
  const { createClient } = await import("@supabase/supabase-js");
  const service = createClient(url, serviceKey, { auth: { persistSession: false } });
  const db = {
    async getPortalBySlug({ slug: want }) {
      const { data } = await service.schema("pods").from("portals").select("*").eq("slug", want).maybeSingle();
      return data;
    },
    async getPortalById({ id }) {
      const { data } = await service.schema("pods").from("portals").select("*").eq("id", id).maybeSingle();
      return data;
    },
  };
  let email = null;
  try {
    const { createServerSupabase } = await import("@/lib/supabase/server.js");
    const supabase = await createServerSupabase();
    const { data } = await supabase.auth.getUser();
    email = data?.user?.email ?? null;
  } catch {
    email = null;
  }
  try {
    const view = await resolvePublishedPortalView(db, { slug, email });
    return { view };
  } catch (error) {
    return { error };
  }
}

export default async function PortalHomePage({ params, searchParams }) {
  const { slug } = await params;
  const query = await searchParams;
  const { view, error } = await loadView(slug);
  if (error) {
    if (error?.status === 401) {
      return (
        <main style={{ maxWidth: 860, margin: "0 auto", padding: "32px 16px" }}>
          <h1>Sign in required</h1>
          <p>This portal is for members only. Sign in to continue.</p>
        </main>
      );
    }
    if (error?.status === 403) {
      return (
        <main style={{ maxWidth: 860, margin: "0 auto", padding: "32px 16px" }}>
          <h1>Not allowed</h1>
          <p>Your account cannot access this portal.</p>
        </main>
      );
    }
    notFound();
  }
  const snapshot = view.snapshot;
  const branding = snapshot.branding ?? {};
  const preview = typeof query?.preview === "string" && query.preview !== "";

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "32px 16px", color: branding.primaryColor ?? undefined }}>
      <h1>{snapshot.name}</h1>
      {preview ? <p>Preview links need workspace sign-in; this page serves the published snapshot.</p> : null}
      {(snapshot.products ?? []).length === 0 ? <p>No products published yet.</p> : null}
      <ul>
        {(snapshot.products ?? []).map((product) => (
          <li key={product.id ?? product.name} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, margin: "12px 0" }}>
            <h2><a href={`./products/${encodeURIComponent(product.id ?? product.name)}`}>{product.name}</a></h2>
            <p>{product.description}</p>
          </li>
        ))}
      </ul>
      {branding.footerMarkdown ? (
        <footer dangerouslySetInnerHTML={{ __html: sanitizeMarkdown(branding.footerMarkdown) }} />
      ) : null}
    </main>
  );
}
