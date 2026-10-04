"use client";

import { ThemeProvider } from "next-themes";
import { SessionProvider } from "@/context/session-context";
import { Toaster } from "@geiger/ui/sonner";

export function Providers({ children }) {
  return <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
    <SessionProvider>{children}</SessionProvider><Toaster />
  </ThemeProvider>;
}
