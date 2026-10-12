"use client";

import { usePathname } from "next/navigation";
import { ThemeProvider } from "next-themes";
import { SessionProvider } from "@/context/session-context";
import { Toaster } from "@geiger/ui/sonner";

// The landing playground (/playground) brings its own fixed session, so it
// never subscribes to the real Supabase one.
const PLAYGROUND_PATH = "/playground";

export function Providers({ children }) {
  const playground = usePathname() === PLAYGROUND_PATH;
  return <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
    {playground ? children : <SessionProvider>{children}</SessionProvider>}<Toaster />
  </ThemeProvider>;
}
