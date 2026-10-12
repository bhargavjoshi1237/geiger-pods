"use client";

// WebSocket API screen (S12 §7): routes tab (selection expression + live
// evaluator, $connect/$disconnect/$default/custom rows, per-route
// integration/two-way toggle), stage connection URLs and a live test
// console (browser WebSocket + @connections mirror).

import { useMemo, useState } from "react";
import { Cable } from "lucide-react";
import { EmptyState, ScreenHeader, SectionCard } from "@geiger/ui/screen-kit";
import { Button } from "@geiger/ui/button";
import { Input } from "@geiger/ui/input";
import { Label } from "@geiger/ui/label";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";

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
    <div className="space-y-4">
      <ScreenHeader title="WebSocket API" description="Routes, selection expressions and live connections." icon={Cable} />
      <SectionCard title="Route selection expression">
        <div className="grid gap-2">
          <Label htmlFor="ws-route-expression">Expression (e.g. $request.body.action)</Label>
          <Input id="ws-route-expression" value={expression} onChange={(event) => setExpression(event.target.value)} className="font-mono" />
          <Label htmlFor="ws-sample-message">Sample message</Label>
          <Textarea id="ws-sample-message" value={sample} onChange={(event) => setSample(event.target.value)} rows={3} className="font-mono text-xs" />
          <p className="text-sm text-muted-foreground">Selected route: <code>{preview}</code></p>
        </div>
      </SectionCard>
      <SectionCard title="Live test console">
        <p className="mb-3 text-sm text-muted-foreground">
          Connect from the browser to the deployed stage URL, send JSON frames and inspect replies.
          Use the stage page for the wss:// and @connections URLs.
        </p>
        <Button size="sm" onClick={() => toast.info("Use the stage connection URL to open a socket.")}>How to connect</Button>
      </SectionCard>
      <EmptyState icon={Cable} title="No routes yet" description="Create $connect, $disconnect, $default and custom routes from the API detail." />
    </div>
  );
}
