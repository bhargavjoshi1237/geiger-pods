import PodsPlaygroundLoader from "@/components/landing/pods_playground_loader";

// The landing-page playground, served on its own route so the showcase can
// embed it in an iframe: the workspace's dialogs, sheets, menus and toasts
// (portalled to <body> with fixed positioning) stay inside the showcase card.
export const metadata = {
  title: "Playground",
  robots: { index: false, follow: false },
};

export default function PodsPlaygroundPage() {
  return <div className="h-[100dvh] w-full overflow-hidden bg-background">
    <PodsPlaygroundLoader />
  </div>;
}
