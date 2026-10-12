import { notFound } from "next/navigation";
import { Badge } from "@geiger/ui/badge";
import { Card } from "@geiger/ui/card";
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

// Access notices (sign-in required / not allowed) share the portal's page frame.
function PortalNotice({ title, children }) {
  return (
    <main className="mx-auto w-full max-w-[860px] px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{children}</p>
    </main>
  );
}

export default async function PortalProductPage({ params }) {
  const { slug, productId } = await params;
  const { view, error } = await loadProductView(slug, productId);
  if (error) {
    if (error?.status === 401) {
      return <PortalNotice title="Sign in required">This portal is for members only. Sign in to continue.</PortalNotice>;
    }
    if (error?.status === 403) {
      return <PortalNotice title="Not allowed">Your account cannot access this portal.</PortalNotice>;
    }
    notFound();
  }
  const product = view.product;

  return (
    <main className="mx-auto w-full max-w-[860px] px-4 py-8">
      <p className="text-sm"><a href="../" className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">Back to {view.snapshot.name}</a></p>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">{product.name}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{product.description}</p>
      {(product.pages ?? []).map((page) => (
        <section key={page.id ?? page.slug} className="my-6">
          <h2 className="mb-2 text-lg font-semibold">{page.title}</h2>
          <div className="text-sm leading-6" dangerouslySetInnerHTML={{ __html: page.html ?? sanitizeMarkdown("") }} />
        </section>
      ))}
      {(product.endpoints ?? []).length > 0 ? (
        <section className="mt-8">
          <h2 className="mb-3 text-lg font-semibold">Endpoints</h2>
          <Card className="gap-0 py-0 shadow-none">
            <ul className="divide-y divide-border">
              {(product.endpoints ?? []).map((endpoint) => (
                <li key={endpoint.id ?? `${endpoint.httpMethod} ${endpoint.resourcePath}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 font-mono text-sm">
                  <Badge variant="outline">{endpoint.httpMethod}</Badge> <span className="min-w-0 break-all">{endpoint.resourcePath}</span>
                  {endpoint.tryItEnabled ? <span className="font-sans text-xs text-muted-foreground">· try it in the console with your API key</span> : null}
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ) : null}
    </main>
  );
}
