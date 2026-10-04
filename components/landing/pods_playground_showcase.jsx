"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@geiger/ui/button";
import { LogoLoading } from "@geiger/ui/logo-loading";

// Client-only: the playground runs the whole workspace in the browser.
const PodsPlayground = dynamic(() => import("./pods_playground").then((mod) => mod.PodsPlayground), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center"><LogoLoading size={80} /></div>,
});

// Landing showcase (mirrors geiger-flow FlowPlaygroundShowcase): intro copy + CTA over a themed photo wash, live workspace below.
export default function PodsPlaygroundShowcase({ ctaHref = "/project", ctaLabel = "Open the workspace", backgroundImage }) {
  return <section
    className="relative overflow-hidden rounded-2xl border border-border bg-surface-subtle bg-cover bg-center bg-no-repeat p-3 sm:rounded-3xl sm:p-6 md:p-8 xl:p-10"
    style={backgroundImage ? { backgroundImage: `url('${backgroundImage}')` } : undefined}
  >
    <div className="absolute inset-0 bg-background/75" />
    <div className="relative z-10 flex flex-col gap-6 sm:gap-10">
      <div className="mx-auto mb-4 mt-4 flex w-[92%] flex-col items-start gap-4 sm:mb-6 sm:mt-6 sm:w-[90%]">
        <h2 className="text-3xl font-semibold leading-tight text-foreground">Try the full Pods workspace in real time.</h2>
        <p className="max-w-lg text-muted-foreground">This playground runs live on the page with the complete workspace — sidebar navigation, the topbar, and every screen. No sign-in and nothing saved, just pure exploration.</p>
        <Button asChild className="rounded-full">
          <Link href={ctaHref}>{ctaLabel}<ArrowRight className="h-4 w-4" /></Link>
        </Button>
      </div>
      <div className="relative rounded-2xl border border-border/80 bg-background/70 p-2 shadow-2xl backdrop-blur-md sm:p-3">
        <div className="h-[680px] overflow-hidden rounded-xl border border-border bg-background sm:h-[760px] lg:h-[900px]">
          <PodsPlayground />
        </div>
      </div>
    </div>
  </section>;
}
