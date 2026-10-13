import React from "react";
import { cn } from "@geiger/ui/lib/utils";

export function MainScreenWrapper({ children, className, ...props }) {
  return (
    <div
      className={cn(
        "space-y-8 w-full px-2 lg:px-0 lg:max-w-[85%] mx-auto py-4",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function SecondaryScreenWrapper({ children, className, ...props }) {
  return (
    <div
      className={cn(
        "space-y-6 w-full px-2 lg:px-0 max-w-5xl mx-auto py-4",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
