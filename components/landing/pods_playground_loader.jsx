"use client";

import dynamic from "next/dynamic";
import { LoadingArea } from "@geiger/ui/screen-kit";

// Client-only: the playground runs the whole workspace, and its seeded
// database, in the browser.
const PodsPlaygroundLoader = dynamic(() => import("./pods_playground").then((mod) => mod.PodsPlayground), {
  ssr: false,
  loading: () => <LoadingArea size={80} label="Loading the Pods playground" className="bg-background" />,
});

export default PodsPlaygroundLoader;
