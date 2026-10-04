import PodsLandingPage from "@/components/landing/landing_page";
import { pickShowcaseBackground } from "@/lib/workspace/playground.mjs";

export const metadata = {
  title: "Geiger Pods — one gateway for your services",
  description: "Bring API routes, access and releases into a Geiger workspace your team already shares. Start with the project workspace foundation.",
};

export default function Page() {
  return <PodsLandingPage playgroundBackground={pickShowcaseBackground()} />;
}
