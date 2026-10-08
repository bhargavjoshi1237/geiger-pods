import { notFound } from "next/navigation";
import { sanitizeMarkdown } from "@/lib/gateway/distribution/portals.mjs";
import { resolvePublishedPortalProductView } from "@/lib/control/portals.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same access contract as the portal home page: the published snapshot only,
// gated by `access.mode === "authenticated"` (suite Supabase session +
// allowed-email-domain filter). Only products frozen into the snapshot at
// publish time render; anything else is 404.
async function loadProductView(slug, productId) {
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
    const view = await resolvePublishedPortalProductView(db, { slug, productId, email });
    return { view };
  } catch (error) {
    return { error };
  }
}

export default async function PortalProductPage({ params }) {
  const { slug, productId } = await params;
  const { view, error } = await loadProductView(slug, productId);
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
  const product = view.product;

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "32px 16px" }}>
      <p><a href="../">Back to {view.snapshot.name}</a></p>
      <h1>{product.name}</h1>
      <p>{product.description}</p>
      {(product.pages ?? []).map((page) => (
        <section key={page.id ?? page.slug} style={{ margin: "16px 0" }}>
          <h2>{page.title}</h2>
          <div dangerouslySetInnerHTML={{ __html: page.html ?? sanitizeMarkdown("") }} />
        </section>
      ))}
      {(product.endpoints ?? []).length > 0 ? (
        <section>
          <h2>Endpoints</h2>
          <ul>
            {(product.endpoints ?? []).map((endpoint) => (
              <li key={endpoint.id ?? `${endpoint.httpMethod} ${endpoint.resourcePath}`} style={{ fontFamily: "monospace" }}>
                {endpoint.httpMethod} {endpoint.resourcePath}
                {endpoint.tryItEnabled ? " · try it in the console with your API key" : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
