"use client";

import Link from "next/link";
import { ArrowRight, Check, Layers, Network, ShieldCheck } from "lucide-react";
import Footer from "@geiger/ui/footer";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Card, CardContent } from "@geiger/ui/card";
import { SuiteHeader } from "@geiger/ui/suite-header";
import { useSession } from "@/context/session-context";
import { ProfileDropdown } from "@/components/account/profile_dropdown";
import { dashHref, productHref } from "@/lib/workspace/model.mjs";
import HeroPods from "./hero_pods";
import PodsPlaygroundShowcase from "./pods_playground_showcase";

const capabilities = [
  { icon: Network, title: "Connect your services", description: "Bring HTTP services, REST APIs and WebSocket connections into one project.", label: "Routing & integrations" },
  { icon: ShieldCheck, title: "Control who gets through", description: "Plan authorization, API keys and usage controls around the consumers of your APIs.", label: "Authorization & usage" },
  { icon: Layers, title: "Release with confidence", description: "Give each environment a stage, preserve deployment versions and make changes traceable.", label: "Stages & deployments" },
];

export default function PodsLandingPage({ playgroundBackground }) {
  const { user, status } = useSession();
  const profile = user ? <ProfileDropdown user={user} /> : status === "loading" ? <div className="size-8 rounded-full border border-border bg-surface-subtle" role="status" aria-label="Checking your Geiger session" /> : null;
  return <div className="bg-background text-foreground">
    <a href="#main-content" className="sr-only z-[60] rounded bg-background p-3 focus:not-sr-only focus:fixed focus:left-4 focus:top-4">Skip to content</a>
    <SuiteHeader userId={user?.id} profile={profile}
      homeHref={dashHref("/")} signInHref={dashHref("/login?next=pods")} dashboardHref={dashHref("/org")}
      logoSrc={productHref("/logo1.svg")}
    />
    <main id="main-content" className="isolate overflow-clip pt-[calc(48px+var(--geiger-banner-h,0px))] [&_:is(a,button):focus-visible]:outline-2 [&_:is(a,button):focus-visible]:outline-offset-4 [&_:is(a,button):focus-visible]:outline-ring">
      <section className="relative isolate">
        <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[540px] [background-image:linear-gradient(to_right,color-mix(in_srgb,var(--foreground)_12%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_srgb,var(--foreground)_12%,transparent)_1px,transparent_1px)] bg-size-[24px_24px] [mask-image:linear-gradient(to_bottom,#000,#000_25%,transparent_90%)]" aria-hidden="true" />
        <div className="mx-auto grid w-full max-w-6xl grid-cols-2 items-center gap-16 px-6 pt-12 pb-4 max-[900px]:grid-cols-1 max-[900px]:gap-12 max-md:gap-8 max-md:pt-8 max-md:pb-2">
          <div className="max-w-[520px] max-[900px]:max-w-[640px]">
            <h1 className="m-0 text-[30px] leading-[1.25] font-semibold tracking-[-.025em] max-md:text-[27px]">One gateway. Every service.</h1>
            <p className="mt-4 mb-6 text-base leading-normal text-muted-foreground max-md:text-sm max-md:leading-[1.7]">Bring your API routes, access and releases into a Geiger workspace your team already shares.</p>
            <div className="flex items-center">
              <Link href="/project" className="inline-flex min-h-10 items-center justify-center gap-2.5 rounded-full bg-primary px-6 py-[9px] text-[15px] font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/88 max-md:text-sm">Get in your workspace<ArrowRight size={16} /></Link>
            </div>
          </div>
          <div className="relative isolate grid min-h-0 place-items-center min-[900px]:-mt-6 min-[900px]:justify-items-end before:pointer-events-none before:absolute before:-inset-x-[8%] before:inset-y-[8%] before:-z-10 before:[background-image:linear-gradient(to_right,color-mix(in_srgb,var(--foreground)_8%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_srgb,var(--foreground)_8%,transparent)_1px,transparent_1px)] before:bg-size-[28px_28px] before:[mask-image:radial-gradient(ellipse_at_center,#000_15%,transparent_75%)] max-[900px]:max-w-[560px] max-md:hidden"><HeroPods /></div>
        </div>
      </section>
      <div id="playground" className="mx-auto mb-10 w-[94%] scroll-mt-20 sm:mb-20 md:w-[80%]"><PodsPlaygroundShowcase backgroundImage={playgroundBackground} /></div>
      <section id="foundation" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
        <div className="grid gap-8 md:grid-cols-[1fr_1.1fr]"><div><Badge variant="outline" className="mb-5">Available now · Phase 0</Badge><h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Start with the<br />workspace you know.</h2><p className="mt-5 max-w-md text-sm leading-7 text-muted-foreground">The same Geiger account. The same projects. A familiar layout for your team’s next infrastructure tool.</p></div><div className="divide-y divide-border border-y border-border">{[["01", "Your Geiger session", "Continue with your existing account, through Geiger Studio."], ["02", "Your shared projects", "Choose an existing project and carry its organization access with you."], ["03", "Your project overview", "Open the workspace, inspect project details and follow the gateway roadmap."]].map(([number, title, detail]) => <div key={number} className="flex gap-5 py-6"><span className="pt-1 font-mono text-xs text-text-tertiary">{number}</span><div><h3 className="text-sm font-semibold">{title}</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">{detail}</p></div><Check className="ml-auto mt-1 size-4 shrink-0 text-muted-foreground" /></div>)}</div></div>
      </section>
      <section id="lifecycle" className="scroll-mt-20 border-y border-border bg-surface-subtle"><div className="mx-auto max-w-6xl px-6 py-20"><p className="mb-4 font-mono text-xs uppercase tracking-widest text-text-tertiary">Where we’re going</p><h2 className="text-3xl font-semibold tracking-tight">The API lifecycle, in one place.</h2><div className="mt-10 grid gap-5 md:grid-cols-3">{capabilities.map(({ icon: Icon, title, description, label }) => <Card key={title} className="gap-0 border-border bg-background py-0"><CardContent className="p-6"><Icon className="mb-8 size-5 text-muted-foreground" /><p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-tertiary">{label} · Planned</p><h3 className="text-lg font-semibold tracking-tight">{title}</h3><p className="mt-3 text-sm leading-6 text-muted-foreground">{description}</p></CardContent></Card>)}</div></div></section>
      <section id="get-started" className="mx-auto flex max-w-6xl scroll-mt-20 flex-col items-start justify-between gap-6 px-6 py-16 sm:flex-row sm:items-center"><div><h2 className="text-2xl font-semibold tracking-tight">Your next service starts here.</h2><p className="mt-2 text-sm text-muted-foreground">Open your project and see the foundation in place.</p></div><Button asChild size="lg"><Link href="/project">Open Pods<ArrowRight className="size-4" /></Link></Button></section>
    </main>
    <Footer />
  </div>;
}
