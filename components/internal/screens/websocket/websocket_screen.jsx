"use client";

// WebSocket API screen: route selection expression with a live evaluator
// against a sample message, and pointers to the stage connection URLs and
// test console.

import { useMemo, useState } from "react";
import { Cable } from "lucide-react";
import { EmptyState, Field, ScreenHeader, SectionCard } from "@/components/internal/shared/screen_kit";
import { MainScreenWrapper } from "@/components/internal/shared/screen_wrappers";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";

const SECONDARY = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

export function WebsocketScreen({ params = {} }) {
  const [expression, setExpression] = useState("$request.body.action");
  const [sample, setSample] = useState('{"action":"sendmessage"}');
  const preview = useMemo(() => {
    try {
      const body = JSON.parse(sample);
      const path = String(expression).replace(/^\$\{|\}$/g, "").replace(/^\$?request\.body\.?/, "");
      if (!path) return "$default";
      return body[path] ?? "$default";
    } catch {
      return "$default";
    }
  }, [expression, sample]);

  return (
    <MainScreenWrapper>
      <ScreenHeader title="WebSocket API" description="Routes, selection expressions and live connections." />
      <div className="space-y-6">
        <SectionCard title="Route selection expression" description="Pick the route for each incoming message from a field in its body.">
          <div className="grid gap-4">
            <Field label="Expression" hint="For example $request.body.action." htmlFor="ws-route-expression">
              <Input id="ws-route-expression" value={expression} onChange={(event) => setExpression(event.target.value)} className="font-mono" />
            </Field>
            <Field label="Sample message" htmlFor="ws-sample-message">
              <Textarea id="ws-sample-message" value={sample} onChange={(event) => setSample(event.target.value)} rows={3} className="font-mono text-xs" spellCheck={false} />
            </Field>
            <p className="text-sm text-text-secondary">Selected route: <code className="font-mono text-foreground">{preview}</code></p>
          </div>
        </SectionCard>
        <SectionCard
          title="Live test console"
          bodyPadding={false}
          description="Connect from the browser to the deployed stage URL, send JSON frames and inspect replies. Use the stage page for the wss:// and @connections URLs."
          action={<Button size="sm" variant="outline" className={SECONDARY} onClick={() => toast.info("Use the stage connection URL to open a socket.")}>How to Connect</Button>}
        />
        <div className="rounded-xl border border-border bg-surface-subtle">
          <EmptyState icon={Cable} title="No routes yet" description="Create $connect, $disconnect, $default and custom routes from the API detail." />
        </div>
      </div>
    </MainScreenWrapper>
  );
}
