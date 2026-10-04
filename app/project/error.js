"use client";

import { EmptyState } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
import { AlertCircle } from "lucide-react";

export default function ErrorPage({ reset }) {
  return <EmptyState icon={AlertCircle} title="This screen could not be opened" description="Try loading it again." action={<Button onClick={reset}>Try again</Button>} />;
}
