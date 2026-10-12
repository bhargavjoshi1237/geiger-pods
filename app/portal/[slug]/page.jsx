import { notFound } from "next/navigation";
import { Card } from "@geiger/ui/card";
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

// Access notices (sign-in required / not allowed) share the portal's page frame.
function PortalNotice({ title, children }) {
  return (
    <main className="mx-auto w-full max-w-[860px] px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{children}</p>
    </main>
  );
}

export default async function PortalHomePage({ params, searchParams }) {
  const { slug } = await params;
  const query = await searchParams;
  const { view, error } = await loadView(slug);
  if (error) {
    if (error?.status === 401) {
      return <PortalNotice title="Sign in required">This portal is for members only. Sign in to continue.</PortalNotice>;
    }
    if (error?.status === 403) {
      return <PortalNotice title="Not allowed">Your account cannot access this portal.</PortalNotice>;
    }
    notFound();
  }
  const snapshot = view.snapshot;
  const branding = snapshot.branding ?? {};
  const preview = typeof query?.preview === "string" && query.preview !== "";

  return (
    <main className="mx-auto w-full max-w-[860px] px-4 py-8" style={branding.primaryColor ? { color: branding.primaryColor } : undefined}>
      <h1 className="text-2xl font-semibold tracking-tight">{snapshot.name}</h1>
      {preview ? <p className="mt-2 text-sm">Preview links need workspace sign-in; this page serves the published snapshot.</p> : null}
      {(snapshot.products ?? []).length === 0 ? <p className="mt-4 text-sm">No products published yet.</p> : null}
      <ul className="mt-6 space-y-3">
        {(snapshot.products ?? []).map((product) => (
          <li key={product.id ?? product.name}>
            {/* text-inherit keeps the branding colour (set on <main>) flowing into the card text. */}
            <Card className="gap-1 p-4 text-inherit shadow-none">
              <h2 className="text-base font-semibold"><a href={`./products/${encodeURIComponent(product.id ?? product.name)}`} className="underline-offset-4 hover:underline">{product.name}</a></h2>
              <p className="text-sm">{product.description}</p>
            </Card>
          </li>
        ))}
      </ul>
      {branding.footerMarkdown ? (
        <footer className="mt-8 border-t border-border pt-4 text-sm" dangerouslySetInnerHTML={{ __html: sanitizeMarkdown(branding.footerMarkdown) }} />
      ) : null}
    </main>
  );
}
