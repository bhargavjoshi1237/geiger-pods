"use client";

import { useEffect } from "react";

// basePath ("/pods" in production) rewrites <Link>, the router and static
// imports, but not a URL we hand straight to the DOM. Without the prefix these
// leave the app entirely and come back as the suite shell's HTML, so every page
// in production quietly runs on the wrong favicon.
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";
const DARK_FAVICON = `${BASE}/favicon.ico`;
const LIGHT_FAVICON = `${BASE}/faviconL.ico`;

export function SystemFavicon() {
  useEffect(() => {
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");

    const updateFavicon = () => {
      document
        .querySelectorAll('link[rel="icon"], link[rel="shortcut icon"]')
        .forEach((link) => link.remove());

      const link = document.createElement("link");
      link.rel = "icon";
      link.type = "image/x-icon";
      link.href = colorScheme.matches ? DARK_FAVICON : LIGHT_FAVICON;
      document.head.appendChild(link);
    };

    updateFavicon();
    colorScheme.addEventListener("change", updateFavicon);

    return () => colorScheme.removeEventListener("change", updateFavicon);
  }, []);

  return null;
}
