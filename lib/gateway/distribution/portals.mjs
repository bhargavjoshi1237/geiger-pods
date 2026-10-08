/**
 * Portal rendering helpers (S13 part D, pure).
 *
 * `sanitizeMarkdown` is the allow-list renderer the public portal uses for
 * product pages and `display_override_markdown`: it strips `script`/`iframe`
 * elements, `on*` event attributes, `javascript:` URLs and `<style>` blocks,
 * then renders a small markdown subset (headings, bold/italic/code, links,
 * lists, paragraphs) to escaped HTML. Bounded inputs, no dependencies.
 *
 * @module lib/gateway/distribution/portals
 */

const MAX_MARKDOWN_BYTES = 256 * 1024;

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeUrl(url) {
  const cleaned = String(url ?? "").trim().slice(0, 2048);
  if (/^(https?:|mailto:)/i.test(cleaned)) return cleaned;
  if (cleaned.startsWith("/") || cleaned.startsWith("#")) return cleaned;
  return "#";
}

function renderInline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`\n]{1,512})`/g, (_, code) => `<code>${code}</code>`);
  out = out.replace(/\*\*([^*]{1,512})\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*\w])\*([^*\n]{1,512})\*/g, "$1<em>$2</em>");
  out = out.replace(/\[([^\]\n]{1,256})\]\(([^)\n]{1,2048})\)/g, (_, label, url) => {
    const safe = sanitizeUrl(url.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
    return `<a href="${escapeHtml(safe)}">${label}</a>`;
  });
  return out;
}

/**
 * Sanitizes markdown to safe HTML (allow-list renderer).
 *
 * @param {unknown} input
 * @returns {string} Safe HTML.
 */
export function sanitizeMarkdown(input) {
  if (typeof input !== "string") return "";
  let text = input;
  if (Buffer.byteLength(text, "utf8") > MAX_MARKDOWN_BYTES) {
    text = Buffer.from(text, "utf8").subarray(0, MAX_MARKDOWN_BYTES).toString("utf8");
  }
  // Strip dangerous elements first (bounded, case-insensitive).
  text = text.replace(/<script[\s\S]{0,65536}?<\/script\s*>/gi, "");
  text = text.replace(/<script[^>]{0,2048}>/gi, "");
  text = text.replace(/<iframe[\s\S]{0,65536}?<\/iframe\s*>/gi, "");
  text = text.replace(/<iframe[^>]{0,2048}\/?>/gi, "");
  text = text.replace(/<style[\s\S]{0,65536}?<\/style\s*>/gi, "");
  text = text.replace(/<object[\s\S]{0,65536}?<\/object\s*>/gi, "");
  text = text.replace(/<embed[^>]{0,2048}\/?>/gi, "");
  text = text.replace(/<link[^>]{0,2048}\/?>/gi, "");
  // Strip event-handler attributes from any surviving tag.
  text = text.replace(/<([a-zA-Z][a-zA-Z0-9-]{0,32})((?:[^>"']|"[^"]{0,2048}"|'[^']{0,2048}')*)>/g, (tag, name, attrs) => {
    const cleaned = String(attrs ?? "")
      .replace(/\s+on[a-zA-Z]{1,32}\s*=\s*("[^"]{0,2048}"|'[^']{0,2048}'|[^\s>]{1,512})/gi, "")
      .replace(/\s+(href|src|xlink:href)\s*=\s*("|')?\s*javascript:[^"'\s>]{0,2048}/gi, " $1=$2#");
    return `<${name}${cleaned}>`;
  });
  // Drop javascript: URLs in markdown link destinations before rendering.
  text = text.replace(/\]\(\s*javascript:[^)\n]{0,2048}\)/gi, "](#)");

  const lines = text.split("\n");
  const html = [];
  let listOpen = false;
  const closeList = () => {
    if (listOpen) {
      html.push("</ul>");
      listOpen = false;
    }
  };
  for (const line of lines.slice(0, 5000)) {
    const heading = /^(#{1,6})\s+(.{1,512})$/.exec(line.trim());
    if (heading) {
      closeList();
      html.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    const item = /^\s*[-*]\s+(.{1,1024})$/.exec(line);
    if (item) {
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${renderInline(item[1])}</li>`);
      continue;
    }
    if (line.trim() === "") {
      closeList();
      continue;
    }
    closeList();
    html.push(`<p>${renderInline(line.slice(0, 2048))}</p>`);
  }
  closeList();
  return html.join("\n");
}

/**
 * Builds the publish snapshot from live portal rows (pure, testable).
 *
 * @param {{ portal: object, products: Array<object>, pagesByProduct: Map<string, Array<object>>,
 *   endpointsByProduct: Map<string, Array<object>>, docsByKey?: Map<string, object> }} input
 * @returns {object} Immutable snapshot stored on `published_snapshot`.
 */
export function buildPortalSnapshot({ portal, products, pagesByProduct, endpointsByProduct, docsByKey = new Map() }) {
  const snapshot = {
    version: 1,
    portalId: portal.id ?? null,
    slug: portal.slug ?? "",
    name: portal.name ?? "",
    branding: { ...(portal.branding ?? {}) },
    products: (products ?? []).map((product) => ({
      id: product.id ?? null,
      name: product.name ?? "",
      description: product.description ?? "",
      displayOrder: product.display_order ?? product.displayOrder ?? 0,
      pages: (pagesByProduct?.get?.(product.id) ?? []).map((page) => ({
        id: page.id ?? null,
        title: page.title ?? "",
        slug: page.slug ?? "",
        html: sanitizeMarkdown(page.body_markdown ?? page.bodyMarkdown ?? ""),
      })),
      endpoints: (endpointsByProduct?.get?.(product.id) ?? []).map((endpoint) => ({
        id: endpoint.id ?? null,
        apiId: endpoint.api_id ?? endpoint.apiId ?? null,
        stageName: endpoint.stage_name ?? endpoint.stageName ?? "",
        resourcePath: endpoint.resource_path ?? endpoint.resourcePath ?? "",
        httpMethod: endpoint.http_method ?? endpoint.httpMethod ?? "",
        operationName: endpoint.operation_name ?? endpoint.operationName ?? "",
        tryItEnabled: (endpoint.try_it_enabled ?? endpoint.tryItEnabled) !== false,
        docs: docsByKey?.get?.(`${endpoint.http_method ?? endpoint.httpMethod} ${endpoint.resource_path ?? endpoint.resourcePath}`) ?? null,
        overrideHtml: endpoint.display_override_markdown ?? endpoint.displayOverrideMarkdown
          ? sanitizeMarkdown(endpoint.display_override_markdown ?? endpoint.displayOverrideMarkdown)
          : null,
      })),
    })),
    publishedAt: new Date().toISOString(),
  };
  return JSON.parse(JSON.stringify(snapshot));
}
