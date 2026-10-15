"use client";

import { useEffect, useRef, useState } from "react";
import { LoadingArea } from "@geiger/ui/screen-kit";

// The live playground card on a landing page: the app's own /playground route in
// an iframe, so the workspace's dialogs, sheets, menus and toasts — portalled to
// <body> with fixed positioning — open inside the card instead of over the
// landing page. Mounts when it scrolls near the viewport and shows the logo loader
// until the workspace has loaded.
//
// `src` is the full path including the app's base path (e.g. "/assets/playground"),
// so geiger-dash can embed any app's playground through its product rewrites.
export function PlaygroundFrame({ src, title, className = "" }) {
  const holder = useRef(null);
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const node = holder.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={holder}
      className={`relative h-[640px] overflow-hidden rounded-lg border border-border bg-background sm:h-[700px] lg:h-[860px] ${className}`}
    >
      {!loaded ? (
        <LoadingArea size={80} label="Loading the playground" className="absolute inset-0" />
      ) : null}
      {visible ? (
        <iframe
          src={src}
          title={title}
          onLoad={() => setLoaded(true)}
          className={`block h-full w-full border-0 transition-opacity duration-300 ${loaded ? "opacity-100" : "opacity-0"}`}
        />
      ) : null}
    </div>
  );
}

export default PlaygroundFrame;
