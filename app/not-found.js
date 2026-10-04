"use client";

import Link from "next/link";
import { EmptyState } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
import { FileQuestion } from "lucide-react";

export default function NotFound() {
  return <EmptyState icon={FileQuestion} title="Page not found" description="This screen is not available. Return to your project workspace." action={<Button asChild><Link href="/project">Open workspace</Link></Button>} />;
}
