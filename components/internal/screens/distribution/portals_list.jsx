"use client";

// Developer portals (`/portals`): the portal list, and an in-place portal
// editor (general settings with branding and access, linked products, pages,
// publish/disable). Published portals serve a frozen snapshot, so edits only
// reach the public page after the next publish.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, Copy, ExternalLink, FileText, Globe, Link2, Loader2, LockKeyhole, Package, Pencil, Plus, Rocket, Send, Settings2 } from "lucide-react";
import { DataTable, EmptyState, Field, LoadingArea, ScreenHeader, SearchInput, SectionCard, SettingRow, SettingsList, StatsBar, StatusPill, Toolbar } from "@/components/internal/shared/screen_kit";
import { MainScreenWrapper } from "@/components/internal/shared/screen_wrappers";
import { ListPagination, usePagination } from "@/components/internal/shared/pagination";
import { EditorHeader, EditorShell } from "@/components/internal/shared/editor_shell";
import { ActionMenu } from "@geiger/ui/action-menu";
import { Badge } from "@geiger/ui/badge";
import { Button } from "@geiger/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@geiger/ui/dialog";
import { Input } from "@geiger/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@geiger/ui/select";
import { Switch } from "@geiger/ui/switch";
import { Textarea } from "@geiger/ui/textarea";
import { toast } from "sonner";
import { useProject } from "@/context/project-context";
import { useRbac } from "@/context/rbac-context";
import { useRecordParam } from "@/lib/hooks/use-record-param";
import { productHref } from "@/lib/workspace/model.mjs";
import FilterDropdown from "../overview/filter_dropdown";

async function portalsFetch(projectId, path, init) {
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/portals`;
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    credentials: "same-origin",
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Portal request failed (${response.status}).`);
  return data;
}

async function productsFetch(projectId, path, init) {
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/products`;
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    credentials: "same-origin",
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Product request failed (${response.status}).`);
  return data;
}

async function apisFetch(projectId) {
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/apis`, {
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

const PORTAL_STATUS_MAP = {
  DRAFT: { label: "Draft", variant: "neutral" },
  PUBLISHED: { label: "Published", variant: "success" },
  DISABLED: { label: "Disabled", variant: "warning" },
};

const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "All Statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "PUBLISHED", label: "Published" },
  { value: "DISABLED", label: "Disabled" },
];

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ANY"];
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,127}$/;

const primary = "bg-primary text-primary-foreground hover:bg-primary/90";
const outlineQuiet = "border-border bg-transparent text-muted-foreground hover:bg-surface-active hover:text-foreground";

const publicPath = (portal) => `/portal/${encodeURIComponent(portal.slug)}`;
const publicHref = (portal) => productHref(publicPath(portal));

const slugify = (value) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 128);

function viewPublicPage(portal) {
  window.open(publicHref(portal), "_blank", "noopener,noreferrer");
}

function copy(value, label) {
  navigator.clipboard?.writeText(value).then(
    () => toast.success(`${label} copied.`),
    () => toast.error(`Couldn't copy the ${label.toLowerCase()}.`),
  );
}

// --- Shared portal actions ----------------------------------------------------

function usePortalActions(onChanged) {
  const { project } = useProject();
  const [busy, setBusy] = useState(false);

  const publish = async (portal) => {
    setBusy(true);
    try {
      await portalsFetch(project.id, `/${encodeURIComponent(portal.id)}/publish`, { method: "POST" });
      toast.success(`Published "${portal.name}". The public portal now serves the frozen snapshot.`);
      await onChanged?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const disable = async (portal) => {
    setBusy(true);
    try {
      await portalsFetch(project.id, `/${encodeURIComponent(portal.id)}`, { method: "PATCH", body: JSON.stringify({ status: "DISABLED" }) });
      toast.success(`Disabled "${portal.name}". Its public URL now returns 404.`);
      await onChanged?.();
      return true;
    } catch (error) {
      toast.error(error.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { busy, publish, disable };
}

function DisablePortalDialog({ portal, onOpenChange, onConfirm, busy }) {
  return <Dialog open={!!portal} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Disable portal</DialogTitle>
        <DialogDescription>
          Disable <span className="font-medium text-foreground">{portal?.name}</span>? Its public page stops serving immediately. Publish again to bring it back.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button className="bg-red-500/90 text-white hover:bg-red-500" disabled={busy} onClick={onConfirm}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />} Disable
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

// --- Create -------------------------------------------------------------------

function CreatePortalDialog({ open, onOpenChange, onCreated }) {
  const { project } = useProject();
  // Keyed by `open` in the parent, so every open starts from an empty form.
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || !slug.trim()) {
      toast.error("Give the portal a name and slug first.");
      return;
    }
    setBusy(true);
    try {
      const created = await portalsFetch(project.id, "", { method: "POST", body: JSON.stringify({ name: name.trim(), slug: slug.trim() }) });
      toast.success(`"${name.trim()}" created as a draft. Publish to freeze a public snapshot.`);
      await onCreated(created);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-xl bg-background">
      <DialogHeader>
        <DialogTitle>Create Portal</DialogTitle>
        <DialogDescription>Set the essentials now — branding, products and pages can follow in the editor.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <Field label="Name" htmlFor="portal-name">
          <Input id="portal-name" autoFocus value={name} maxLength={128} placeholder="Acme Developers" onChange={(event) => {
            setName(event.target.value);
            if (!slugTouched) setSlug(slugify(event.target.value));
          }} />
        </Field>
        <Field label="Slug" htmlFor="portal-slug" hint={`Public page: ${productHref(`/portal/${slug || "your-slug"}`)}`}>
          <Input id="portal-slug" value={slug} spellCheck={false} placeholder="acme-developers" className="font-mono text-xs" onChange={(event) => {
            setSlugTouched(true);
            setSlug(event.target.value);
          }} />
        </Field>
      </div>
      <DialogFooter>
        <Button variant="outline" className={outlineQuiet} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button className={primary} disabled={busy} onClick={submit}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Create Portal</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function CreateProductDialog({ open, onOpenChange, onCreated }) {
  const { project } = useProject();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) {
      toast.error("Give the product a name first.");
      return;
    }
    setBusy(true);
    try {
      const created = await productsFetch(project.id, "", { method: "POST", body: JSON.stringify({ name: name.trim(), description: description.trim() }) });
      toast.success(`"${name.trim()}" created.`);
      await onCreated(created);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md bg-background">
      <DialogHeader>
        <DialogTitle>New Product</DialogTitle>
        <DialogDescription>Products group the docs and endpoint pages a portal shows.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <Field label="Name" htmlFor="product-name">
          <Input id="product-name" autoFocus value={name} maxLength={128} onChange={(event) => setName(event.target.value)} placeholder="Payments API" />
        </Field>
        <Field label="Description (optional)" htmlFor="product-description">
          <Textarea id="product-description" rows={3} maxLength={2048} value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>
      </div>
      <DialogFooter>
        <Button variant="outline" className={outlineQuiet} onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button className={primary} disabled={busy} onClick={submit}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Create Product</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

// --- Editor sections ----------------------------------------------------------

function GeneralSection({ portal, form, set, canWrite }) {
  const disabled = !canWrite;
  return <div className="space-y-6">
    <SectionCard title="Portal" description="How the portal is named and where it lives.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="portal-edit-name">
          <Input id="portal-edit-name" value={form.name} maxLength={128} disabled={disabled} onChange={(event) => set({ name: event.target.value })} />
        </Field>
        <Field label="Public URL" hint="The slug can't change after creation.">
          <div className="flex items-center gap-1">
            <Input readOnly value={publicHref(portal)} className="font-mono text-xs" />
            <Button variant="ghost" size="icon-sm" aria-label="Copy public URL" className="text-muted-foreground hover:bg-surface-active hover:text-foreground" onClick={() => copy(new URL(publicHref(portal), window.location.origin).toString(), "Public URL")}>
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </Field>
      </div>
    </SectionCard>
    <SectionCard title="Branding" description="Theme and colors for the public pages.">
      <div className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Theme" htmlFor="portal-theme">
            <Select value={form.theme} onValueChange={(value) => set({ theme: value })} disabled={disabled}>
              <SelectTrigger id="portal-theme" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="system">Match visitor</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {[["primaryColor", "Primary color"], ["accentColor", "Accent color"]].map(([key, label]) => <Field key={key} label={label} htmlFor={`portal-${key}`}>
            <div className="flex items-center gap-2">
              <span className="h-9 w-9 shrink-0 rounded-lg border border-border" style={{ background: form[key] || "transparent" }} aria-hidden />
              <Input id={`portal-${key}`} value={form[key]} disabled={disabled} placeholder="#4f46e5" spellCheck={false} className="font-mono text-xs" onChange={(event) => set({ [key]: event.target.value })} />
            </div>
          </Field>)}
        </div>
        <Field label="Footer (Markdown)" htmlFor="portal-footer">
          <Textarea id="portal-footer" rows={4} value={form.footerMarkdown} disabled={disabled} className="font-mono text-xs" onChange={(event) => set({ footerMarkdown: event.target.value })} />
        </Field>
      </div>
    </SectionCard>
    <SectionCard title="Access" description="Who can open the published portal.">
      <SettingsList>
        <SettingRow
          icon={LockKeyhole}
          title="Require sign-in"
          description="Visitors sign in with their Geiger account before they see any content."
          control={<Switch checked={form.mode === "authenticated"} disabled={disabled} onCheckedChange={(on) => set({ mode: on ? "authenticated" : "public" })} aria-label="Require sign-in" />}
        />
      </SettingsList>
      {form.mode === "authenticated" ? <Field label="Allowed email domains" htmlFor="portal-domains" hint="Comma-separated. Leave empty to allow any signed-in visitor." className="mt-4">
        <Input id="portal-domains" value={form.allowedEmailDomains} disabled={disabled} placeholder="acme.com, partner.io" spellCheck={false} className="font-mono text-xs" onChange={(event) => set({ allowedEmailDomains: event.target.value })} />
      </Field> : null}
    </SectionCard>
  </div>;
}

function ProductsSection({ portal, products, links, canWrite, onLinked }) {
  const { project } = useProject();
  const [busyId, setBusyId] = useState(null);
  const linked = useMemo(() => new Set(links.map((link) => link.product_id ?? link.productId)), [links]);

  const link = async (product) => {
    setBusyId(product.id);
    try {
      await portalsFetch(project.id, `/${encodeURIComponent(portal.id)}/links`, { method: "POST", body: JSON.stringify({ productId: product.id, order: linked.size }) });
      toast.success(`Linked "${product.name}". Publish to show it on the public portal.`);
      await onLinked();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusyId(null);
    }
  };

  const columns = [
    {
      key: "name",
      header: "Product",
      render: (product) => <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-card text-muted-foreground"><Package className="h-4 w-4" /></div>
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{product.name}</p>
          <p className="block max-w-[26rem] truncate text-xs text-text-secondary">{product.description || "No description"}</p>
        </div>
      </div>,
    },
    { key: "owner", header: "Owner", render: (product) => <Badge variant="outline">{product.projectId === project.id ? "This project" : "Shared with you"}</Badge> },
    { key: "linked", header: "On this portal", render: (product) => (linked.has(product.id) ? <StatusPill status="linked" map={{ linked: { label: "Linked", variant: "success" } }} /> : <span className="text-sm text-text-secondary">Not linked</span>) },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (product) => (canWrite && !linked.has(product.id)
        ? <Button size="sm" variant="outline" className={outlineQuiet} disabled={busyId === product.id} onClick={() => link(product)}>
          {busyId === product.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />} Link
        </Button>
        : null),
    },
  ];

  return <div className="space-y-4">
    <DataTable
      columns={columns}
      data={products}
      getRowKey={(product) => product.id}
      empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
        icon={Package}
        title="No products yet"
        description="Products group endpoint pages and docs. Share them across projects to reuse them on other portals."
      /></div>}
    />
    <p className="text-xs text-text-tertiary">Linked products appear on the public portal after the next publish.</p>
  </div>;
}

function PagesSection({ products, canWrite }) {
  const { project } = useProject();
  const owned = products.filter((product) => product.projectId === project.id);
  const [apis, setApis] = useState([]);
  const [page, setPage] = useState({ productId: owned[0]?.id ?? "", title: "", slug: "", bodyMarkdown: "" });
  const [endpoint, setEndpoint] = useState({ productId: owned[0]?.id ?? "", apiId: "", stageName: "", resourcePath: "/", httpMethod: "GET", operationName: "", tryItEnabled: true });
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    let alive = true;
    apisFetch(project.id).then(
      (data) => { if (alive) setApis((data.items ?? []).filter((api) => api.protocol === "REST")); },
      () => { if (alive) setApis([]); },
    );
    return () => { alive = false; };
  }, [project.id]);

  if (!canWrite) {
    return <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={LockKeyhole} title="Read-only" description="Adding pages needs the Manage developer portals permission." /></div>;
  }
  if (owned.length === 0) {
    return <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={FileText} title="No products to add pages to" description="Pages belong to a product owned by this project. Create one under Products & APIs first." /></div>;
  }

  const addPage = async () => {
    if (!page.productId || !page.title.trim()) {
      toast.error("Pick a product and give the page a title first.");
      return;
    }
    if (!SLUG_PATTERN.test(page.slug)) {
      toast.error("Slugs are 2–128 lowercase letters, digits and dashes.");
      return;
    }
    setBusy("page");
    try {
      await productsFetch(project.id, `/${encodeURIComponent(page.productId)}/pages`, {
        method: "POST",
        body: JSON.stringify({ title: page.title.trim(), slug: page.slug, bodyMarkdown: page.bodyMarkdown }),
      });
      toast.success(`Added "${page.title.trim()}".`);
      setPage((current) => ({ ...current, title: "", slug: "", bodyMarkdown: "" }));
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(null);
    }
  };

  const addEndpoint = async () => {
    if (!endpoint.productId || !endpoint.apiId || !endpoint.stageName.trim()) {
      toast.error("Pick a product, an API and a stage first.");
      return;
    }
    if (!endpoint.resourcePath.startsWith("/")) {
      toast.error('Resource paths start with "/".');
      return;
    }
    setBusy("endpoint");
    try {
      await productsFetch(project.id, `/${encodeURIComponent(endpoint.productId)}/pages`, {
        method: "POST",
        body: JSON.stringify({
          kind: "endpoint",
          apiId: endpoint.apiId,
          stageName: endpoint.stageName.trim(),
          resourcePath: endpoint.resourcePath,
          httpMethod: endpoint.httpMethod,
          operationName: endpoint.operationName.trim(),
          tryItEnabled: endpoint.tryItEnabled,
        }),
      });
      toast.success(`Added ${endpoint.httpMethod} ${endpoint.resourcePath}.`);
      setEndpoint((current) => ({ ...current, resourcePath: "/", operationName: "" }));
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(null);
    }
  };

  const productSelect = (value, onChange, id) => <Select value={value} onValueChange={onChange}>
    <SelectTrigger id={id} className="w-full"><SelectValue placeholder="Select product" /></SelectTrigger>
    <SelectContent>{owned.map((product) => <SelectItem key={product.id} value={product.id}>{product.name}</SelectItem>)}</SelectContent>
  </Select>;

  return <div className="space-y-6">
    <SectionCard
      title="Docs page"
      description="A Markdown page shown under its product."
      action={<Button size="sm" className={primary} disabled={busy === "page"} onClick={addPage}>{busy === "page" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add Page</Button>}
    >
      <div className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Product" htmlFor="page-product">{productSelect(page.productId, (value) => setPage((current) => ({ ...current, productId: value })), "page-product")}</Field>
          <Field label="Title" htmlFor="page-title">
            <Input id="page-title" value={page.title} maxLength={256} placeholder="Getting started" onChange={(event) => {
              const title = event.target.value;
              setPage((current) => ({ ...current, title, slug: current.slug && current.slug !== slugify(current.title) ? current.slug : slugify(title) }));
            }} />
          </Field>
          <Field label="Slug" htmlFor="page-slug">
            <Input id="page-slug" value={page.slug} spellCheck={false} placeholder="getting-started" className="font-mono text-xs" onChange={(event) => setPage((current) => ({ ...current, slug: event.target.value }))} />
          </Field>
        </div>
        <Field label="Body (Markdown)" htmlFor="page-body">
          <Textarea id="page-body" rows={8} value={page.bodyMarkdown} className="font-mono text-xs" onChange={(event) => setPage((current) => ({ ...current, bodyMarkdown: event.target.value }))} />
        </Field>
      </div>
    </SectionCard>

    <SectionCard
      title="Endpoint page"
      description="A reference page for one operation on a deployed REST stage."
      action={<Button size="sm" className={primary} disabled={busy === "endpoint"} onClick={addEndpoint}>{busy === "endpoint" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add Endpoint</Button>}
    >
      <div className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Product" htmlFor="endpoint-product">{productSelect(endpoint.productId, (value) => setEndpoint((current) => ({ ...current, productId: value })), "endpoint-product")}</Field>
          <Field label="API" htmlFor="endpoint-api">
            <Select value={endpoint.apiId} onValueChange={(value) => setEndpoint((current) => ({ ...current, apiId: value }))}>
              <SelectTrigger id="endpoint-api" className="w-full"><SelectValue placeholder={apis.length ? "Select REST API" : "No REST APIs"} /></SelectTrigger>
              <SelectContent>{apis.map((api) => <SelectItem key={api.id} value={api.publicId ?? api.id}>{api.name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Stage" htmlFor="endpoint-stage">
            <Input id="endpoint-stage" value={endpoint.stageName} maxLength={128} placeholder="prod" spellCheck={false} onChange={(event) => setEndpoint((current) => ({ ...current, stageName: event.target.value }))} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Method" htmlFor="endpoint-method">
            <Select value={endpoint.httpMethod} onValueChange={(value) => setEndpoint((current) => ({ ...current, httpMethod: value }))}>
              <SelectTrigger id="endpoint-method" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{HTTP_METHODS.map((method) => <SelectItem key={method} value={method}>{method}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Resource path" htmlFor="endpoint-path">
            <Input id="endpoint-path" value={endpoint.resourcePath} placeholder="/pets/{id}" spellCheck={false} className="font-mono text-xs" onChange={(event) => setEndpoint((current) => ({ ...current, resourcePath: event.target.value }))} />
          </Field>
          <Field label="Operation name (optional)" htmlFor="endpoint-operation">
            <Input id="endpoint-operation" value={endpoint.operationName} maxLength={256} placeholder="Get a pet" onChange={(event) => setEndpoint((current) => ({ ...current, operationName: event.target.value }))} />
          </Field>
        </div>
        <SettingsList>
          <SettingRow
            title="Try it"
            description="Let visitors send live requests from the page."
            checked={endpoint.tryItEnabled}
            onCheckedChange={(on) => setEndpoint((current) => ({ ...current, tryItEnabled: on }))}
          />
        </SettingsList>
      </div>
    </SectionCard>
    <p className="text-xs text-text-tertiary">New pages appear on the public portal after the next publish.</p>
  </div>;
}

function PublishSection({ portal, canWrite, canPublish, busy, onPublish, onDisable }) {
  return <div className="space-y-6">
    <SectionCard title="Status" description="Publishing freezes products, pages and branding into a snapshot that the public page serves.">
      <SettingsList>
        <SettingRow icon={Globe} title="Current status" description={portal.status === "PUBLISHED" ? "Visitors see the last published snapshot." : portal.status === "DISABLED" ? "The public URL returns 404." : "Not public yet. Publish to go live."} control={<StatusPill status={portal.status} map={PORTAL_STATUS_MAP} />} />
        <SettingRow
          icon={ExternalLink}
          title="Public page"
          description={publicHref(portal)}
          control={<Button variant="outline" size="sm" className={outlineQuiet} onClick={() => viewPublicPage(portal)}><ExternalLink className="h-4 w-4" /> Open</Button>}
        />
        {canPublish ? <SettingRow
          icon={Rocket}
          title={portal.status === "PUBLISHED" ? "Publish again" : "Publish"}
          description="Freeze the current draft and serve it publicly."
          control={<Button size="sm" className={primary} disabled={busy} onClick={() => onPublish(portal)}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Publish</Button>}
        /> : null}
      </SettingsList>
    </SectionCard>
    {canWrite && portal.status !== "DISABLED" ? <SectionCard title="Danger zone" description="Disabling takes the public page offline until you publish again.">
      <Button className="bg-red-500/90 text-white hover:bg-red-500" disabled={busy} onClick={() => onDisable(portal)}><Ban className="h-4 w-4" /> Disable Portal</Button>
    </SectionCard> : null}
  </div>;
}

const EDITOR_NAV = [{
  group: null,
  items: [
    { key: "general", label: "General", icon: Settings2, desc: "Name, branding and who can open the portal." },
    { key: "products", label: "Products & APIs", icon: Package, desc: "Products linked to this portal." },
    { key: "pages", label: "Pages", icon: FileText, desc: "Docs and endpoint pages inside each product." },
    { key: "publish", label: "Publish", icon: Rocket, desc: "Go live, republish or take the portal offline." },
  ],
}];

function toForm(detail) {
  const branding = detail?.branding ?? {};
  const access = detail?.access ?? { mode: "public" };
  return {
    name: detail?.name ?? "",
    theme: branding.theme ?? "system",
    primaryColor: branding.primaryColor ?? "",
    accentColor: branding.accentColor ?? "",
    footerMarkdown: branding.footerMarkdown ?? "",
    mode: access.mode ?? "public",
    allowedEmailDomains: (access.oidc?.allowedEmailDomains ?? []).join(", "),
  };
}

function PortalEditor({ portalId, summary, products, onBack, onChanged, onProductsChanged }) {
  const { project } = useProject();
  const { can } = useRbac();
  const canWrite = can("pods.portal.write");
  const canPublish = can("pods.portal.publish");
  const [state, setState] = useState({ status: "loading", detail: null, links: [], error: null });
  const [form, setForm] = useState(() => toForm(null));
  const [saving, setSaving] = useState(false);
  const [active, setActive] = useState("general");
  const [disableTarget, setDisableTarget] = useState(null);
  const [productOpen, setProductOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [detail, links] = await Promise.all([
        portalsFetch(project.id, `/${encodeURIComponent(portalId)}`, {}),
        portalsFetch(project.id, `/${encodeURIComponent(portalId)}/links`, {}),
      ]);
      setState({ status: "ready", detail, links: links.items ?? [], error: null });
      return detail;
    } catch (error) {
      setState((current) => ({ ...current, status: current.detail ? "ready" : "error", error: error.message }));
      return null;
    }
  }, [project.id, portalId]);

  useEffect(() => {
    let alive = true;
    Promise.all([
      portalsFetch(project.id, `/${encodeURIComponent(portalId)}`, {}),
      portalsFetch(project.id, `/${encodeURIComponent(portalId)}/links`, {}),
    ]).then(
      ([detail, links]) => {
        if (!alive) return;
        setState({ status: "ready", detail, links: links.items ?? [], error: null });
        setForm(toForm(detail));
      },
      (error) => { if (alive) setState({ status: "error", detail: null, links: [], error: error.message }); },
    );
    return () => { alive = false; };
  }, [project.id, portalId]);

  const refreshAll = async () => {
    await Promise.all([load(), onChanged()]);
  };

  const actions = usePortalActions(refreshAll);
  const set = useCallback((patch) => setForm((current) => ({ ...current, ...patch })), []);

  const portal = state.detail ?? summary;

  const save = async () => {
    if (!form.name.trim()) {
      toast.error("Give the portal a name first.");
      return;
    }
    const detail = state.detail ?? {};
    const branding = { ...(detail.branding ?? {}), theme: form.theme, footerMarkdown: form.footerMarkdown };
    for (const key of ["primaryColor", "accentColor"]) {
      if (form[key].trim()) branding[key] = form[key].trim();
      else delete branding[key];
    }
    const domains = form.allowedEmailDomains.split(",").map((entry) => entry.trim()).filter(Boolean);
    const previousOidc = detail.access?.oidc;
    const access = { mode: form.mode };
    if (previousOidc || domains.length) access.oidc = { ...(previousOidc ?? {}), allowedEmailDomains: domains };
    setSaving(true);
    try {
      const saved = await portalsFetch(project.id, `/${encodeURIComponent(portalId)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: form.name.trim(), branding, access }),
      });
      setState((current) => ({ ...current, detail: { ...current.detail, ...saved } }));
      setForm(toForm(saved));
      toast.success("Changes saved. Publish to update the public portal.");
      await onChanged();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const confirmDisable = async () => {
    const ok = await actions.disable(disableTarget);
    if (ok) setDisableTarget(null);
  };

  if (state.status === "loading" || state.status === "error") {
    return <MainScreenWrapper>
      <EditorHeader back={{ label: "All Portals", onClick: onBack }} title={summary.name} status={summary.status} statusMap={PORTAL_STATUS_MAP} />
      {state.status === "loading"
        ? <LoadingArea panel label="Loading portal" />
        : <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState icon={Globe} title="Portal unavailable" description={state.error} action={<Button variant="outline" onClick={() => { setState((current) => ({ ...current, status: "loading" })); load().then((detail) => { if (detail) setForm(toForm(detail)); }); }}>Retry</Button>} /></div>}
    </MainScreenWrapper>;
  }

  return <>
    <EditorShell
      back={{ label: "All Portals", onClick: onBack }}
      title={portal.name}
      status={portal.status}
      statusMap={PORTAL_STATUS_MAP}
      meta={publicHref(portal)}
      actions={<>
        <Button variant="outline" className={outlineQuiet} onClick={() => viewPublicPage(portal)} title="View public page" aria-label="View public page">
          <ExternalLink className="h-4 w-4" />
        </Button>
        {canWrite ? <Button className={primary} disabled={saving} onClick={save}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{saving ? "Saving…" : "Save Changes"}
        </Button> : null}
      </>}
      nav={EDITOR_NAV}
      active={active}
      onActiveChange={setActive}
      sectionAction={active === "products" && canWrite
        ? <Button size="sm" variant="outline" className={outlineQuiet} onClick={() => setProductOpen(true)}><Plus className="h-4 w-4" /> New Product</Button>
        : null}
    >
      {({ active: section }) => {
        if (section === "products") return <ProductsSection portal={portal} products={products} links={state.links} canWrite={canWrite} onLinked={load} />;
        if (section === "pages") return <PagesSection products={products} canWrite={canWrite} />;
        if (section === "publish") return <PublishSection portal={portal} canWrite={canWrite} canPublish={canPublish} busy={actions.busy} onPublish={actions.publish} onDisable={setDisableTarget} />;
        return <GeneralSection portal={portal} form={form} set={set} canWrite={canWrite} />;
      }}
    </EditorShell>
    <CreateProductDialog
      key={productOpen ? "product-open" : "product-closed"}
      open={productOpen}
      onOpenChange={setProductOpen}
      onCreated={async () => { setProductOpen(false); await onProductsChanged(); }}
    />
    <DisablePortalDialog portal={disableTarget} onOpenChange={(open) => { if (!open) setDisableTarget(null); }} onConfirm={confirmDisable} busy={actions.busy} />
  </>;
}

// --- List ---------------------------------------------------------------------

export function PortalListScreen() {
  const { project } = useProject();
  const { can } = useRbac();
  const [state, setState] = useState({ status: "loading", portals: [], products: [], error: null });
  const [creating, setCreating] = useState(false);
  const [disableTarget, setDisableTarget] = useState(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [recordId, setRecordId] = useRecordParam();
  const canWrite = can("pods.portal.write");
  const canPublish = can("pods.portal.publish");

  const refresh = useCallback(async () => {
    try {
      const [portals, products] = await Promise.all([
        portalsFetch(project.id, "", {}),
        productsFetch(project.id, "", {}),
      ]);
      setState({ status: "ready", portals: portals.items ?? [], products: products.items ?? [], error: null });
    } catch (error) {
      setState({ status: "error", portals: [], products: [], error: error.message });
    }
  }, [project.id]);

  const refreshProducts = useCallback(async () => {
    try {
      const products = await productsFetch(project.id, "", {});
      setState((current) => ({ ...current, products: products.items ?? [] }));
    } catch (error) {
      toast.error(error.message);
    }
  }, [project.id]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [portals, products] = await Promise.all([
          portalsFetch(project.id, "", {}),
          productsFetch(project.id, "", {}),
        ]);
        if (alive) setState({ status: "ready", portals: portals.items ?? [], products: products.items ?? [], error: null });
      } catch (error) {
        if (alive) setState({ status: "error", portals: [], products: [], error: error.message });
      }
    })();
    return () => { alive = false; };
  }, [project.id]);

  const actions = usePortalActions(refresh);
  const portals = state.portals;

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return portals.filter((portal) => {
      if (statusFilter !== "all" && portal.status !== statusFilter) return false;
      return !query || `${portal.name} ${portal.slug}`.toLowerCase().includes(query);
    });
  }, [portals, search, statusFilter]);

  const pager = usePagination(filtered, { resetKey: `${search}|${statusFilter}` });

  const stats = useMemo(() => [
    { label: "Portals", value: String(portals.length), footer: "In this project" },
    { label: "Published", value: String(portals.filter((portal) => portal.status === "PUBLISHED").length), footer: "Serving a snapshot" },
    { label: "Drafts", value: String(portals.filter((portal) => portal.status === "DRAFT").length), footer: "Not public yet" },
    { label: "Products", value: String(state.products.length), footer: "Owned or shared with you" },
  ], [portals, state.products]);

  const confirmDisable = async () => {
    const ok = await actions.disable(disableTarget);
    if (ok) setDisableTarget(null);
  };

  const openSummary = portals.find((portal) => portal.id === recordId) ?? null;
  if (recordId && (openSummary || state.status === "ready")) {
    return <PortalEditor
      key={recordId}
      portalId={recordId}
      summary={openSummary ?? { id: recordId, name: "Portal", slug: "", status: "DRAFT" }}
      products={state.products}
      onBack={() => setRecordId(null)}
      onChanged={refresh}
      onProductsChanged={refreshProducts}
    />;
  }

  const createButton = canWrite ? <Button className={primary} onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New Portal</Button> : null;

  const columns = [
    {
      key: "name",
      header: "Portal",
      render: (portal) => <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-card text-muted-foreground"><Globe className="h-4 w-4" /></div>
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{portal.name}</p>
          <p className="truncate font-mono text-xs text-text-secondary">/{portal.slug}</p>
        </div>
      </div>,
    },
    { key: "status", header: "Status", render: (portal) => <StatusPill status={portal.status} map={PORTAL_STATUS_MAP} /> },
    { key: "url", header: "Public URL", render: (portal) => <span className="font-mono text-xs text-text-secondary">{publicHref(portal)}</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      className: "text-right",
      render: (portal) => <ActionMenu
        label={`Actions for ${portal.name}`}
        items={[
          { icon: Pencil, label: canWrite ? "Edit" : "Open", onSelect: () => setRecordId(portal.id) },
          { icon: ExternalLink, label: "View public page", onSelect: () => viewPublicPage(portal) },
          canPublish && { icon: Send, label: "Publish", disabled: actions.busy, onSelect: () => actions.publish(portal) },
          canWrite && portal.status !== "DISABLED" && { separator: true },
          canWrite && portal.status !== "DISABLED" && { icon: Ban, label: "Disable", destructive: true, onSelect: () => setDisableTarget(portal) },
        ]}
      />,
    },
  ];

  return <MainScreenWrapper>
    <ScreenHeader
      title="Portals"
      description="Publish API products with docs, branding and access control. Public pages serve a frozen snapshot of each publish."
      actions={createButton}
    />

    <StatsBar stats={stats} />

    <Toolbar>
      <div className="flex flex-wrap items-center gap-2">
        <FilterDropdown label="Status" value={statusFilter} onValueChange={setStatusFilter} options={STATUS_FILTER_OPTIONS} height="h-9" />
      </div>
      <SearchInput value={search} onChange={setSearch} placeholder="Search portals, slugs…" />
    </Toolbar>

    {state.status === "loading" ? <LoadingArea panel label="Loading portals" /> : null}
    {state.status === "error" ? <div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
      icon={Globe}
      title="Portals unavailable"
      description={state.error}
      action={<Button variant="outline" onClick={() => { setState((current) => ({ ...current, status: "loading" })); refresh(); }}>Retry</Button>}
    /></div> : null}
    {state.status === "ready" ? <div className="space-y-5">
      <DataTable
        columns={columns}
        data={pager.pageItems}
        getRowKey={(portal) => portal.id}
        onRowClick={(portal) => setRecordId(portal.id)}
        empty={<div className="rounded-xl border border-border bg-surface-subtle"><EmptyState
          icon={Globe}
          title={portals.length ? "No portals match your filters" : "No portals yet"}
          description={portals.length
            ? "Try clearing the search or status filter."
            : "A portal starts as a draft. Link products, add pages, then publish it to share your APIs."}
          action={portals.length ? null : createButton}
        /></div>}
      />
      <ListPagination {...pager} itemLabel="portals" />
    </div> : null}

    {canWrite ? <CreatePortalDialog
      key={creating ? "create-open" : "create-closed"}
      open={creating}
      onOpenChange={setCreating}
      onCreated={async (created) => {
        setCreating(false);
        await refresh();
        if (created?.id) setRecordId(created.id);
      }}
    /> : null}
    <DisablePortalDialog portal={disableTarget} onOpenChange={(open) => { if (!open) setDisableTarget(null); }} onConfirm={confirmDisable} busy={actions.busy} />
  </MainScreenWrapper>;
}
