import {
  resolveExtensions,
  type MdfnDiagnostic,
  type MdfnDocument,
  type MdfnExtension,
  type MdfnJsonValue,
  type MdfnNode,
  type ResolvedExtensionRegistry,
} from "@mdfn/core";

export interface LinkPolicy {
  readonly allowedSchemes?: readonly string[];
  readonly allowRelative?: boolean;
  readonly allowProtocolRelative?: boolean;
  readonly externalTarget?: "_blank" | "_self" | null;
  readonly externalRel?: string;
}

export interface ImagePolicy {
  readonly allowedSchemes?: readonly string[];
  readonly allowRelative?: boolean;
  readonly loading?: "lazy" | "eager";
  readonly decoding?: "async" | "sync" | "auto";
}

export interface RenderPolicy {
  readonly links?: LinkPolicy;
  readonly images?: ImagePolicy;
  readonly rawHtml?: { readonly enabled: boolean; readonly sanitize?: (raw: string) => string };
  readonly maxNodes?: number;
  readonly maxDepth?: number;
  readonly maxOutputBytes?: number;
  readonly extensions?: readonly MdfnExtension[] | ResolvedExtensionRegistry;
}

export interface RenderResult {
  readonly html: string;
  readonly diagnostics: readonly MdfnDiagnostic[];
  readonly nodeCount: number;
}

export interface RenderTreeNode {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, MdfnJsonValue>>;
  readonly text?: string;
  readonly children?: readonly RenderTreeNode[];
}

const DEFAULT_LINKS: Required<LinkPolicy> = {
  allowedSchemes: ["http", "https", "mailto"],
  allowRelative: true,
  allowProtocolRelative: false,
  externalTarget: "_blank",
  externalRel: "noreferrer noopener",
};

const DEFAULT_IMAGES: Required<ImagePolicy> = {
  allowedSchemes: ["http", "https"],
  allowRelative: true,
  loading: "lazy",
  decoding: "async",
};

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function stringAttr(node: MdfnNode, name: string): string {
  const value = node.attrs?.[name];
  return typeof value === "string" ? value : "";
}

function numberAttr(node: MdfnNode, name: string, fallback: number): number {
  const value = node.attrs?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanAttr(node: MdfnNode, name: string): boolean {
  return node.attrs?.[name] === true;
}

function isRelativeUrl(url: string): boolean {
  return url.startsWith("#") || url.startsWith("/") || url.startsWith("./") || url.startsWith("../") || !/^[a-z][a-z0-9+.-]*:/i.test(url);
}

function validateUrl(url: string, policy: { allowedSchemes: readonly string[]; allowRelative: boolean; allowProtocolRelative: boolean }): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (/[\u0000-\u0020\u007f]/.test(trimmed) || trimmed.includes("\\")) return false;
  if (trimmed.startsWith("//")) return policy.allowProtocolRelative;
  if (isRelativeUrl(trimmed)) return policy.allowRelative;
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  return Boolean(match && policy.allowedSchemes.includes(match[1].toLowerCase()));
}

function isExternal(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function resolveRegistry(policy: RenderPolicy): ResolvedExtensionRegistry {
  const configured = policy.extensions;
  if (configured && "schemaHash" in configured) return configured;
  return resolveExtensions(configured ?? []);
}

function renderChildren(node: MdfnNode, context: RenderContext, depth: number): string {
  return (node.content ?? []).map((child) => renderNode(child, context, depth + 1)).join("");
}

interface RenderContext {
  readonly policy: RenderPolicy;
  readonly registry: ResolvedExtensionRegistry;
  readonly diagnostics: MdfnDiagnostic[];
  nodeCount: number;
}

function pushUnsafeUrl(context: RenderContext, node: MdfnNode, kind: "link" | "image", url: string): void {
  context.diagnostics.push({
    code: "MDFN_UNSAFE_URL_BLOCKED",
    message: `Unsafe ${kind} URL was blocked`,
    severity: "warning",
    nodeId: node.id,
    source: node.source ? { from: node.source.from, to: node.source.to } : undefined,
    details: { kind, scheme: /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase() ?? "relative" },
  });
}

function renderNode(node: MdfnNode, context: RenderContext, depth: number): string {
  context.nodeCount += 1;
  const maxNodes = context.policy.maxNodes ?? 100_000;
  const maxDepth = context.policy.maxDepth ?? 128;
  if (context.nodeCount > maxNodes) throw new RangeError(`MDFN_RENDER_NODE_LIMIT_EXCEEDED:${maxNodes}`);
  if (depth > maxDepth) throw new RangeError(`MDFN_RENDER_DEPTH_LIMIT_EXCEEDED:${maxDepth}`);

  for (const extension of context.registry.extensions) {
    const rendered = extension.render?.({ node, escape: escapeHtml });
    if (rendered !== null && rendered !== undefined) return rendered;
  }

  const children = () => renderChildren(node, context, depth);
  switch (node.type) {
    case "text": return escapeHtml(node.text ?? "");
    case "paragraph": return `<p>${children()}</p>`;
    case "heading": {
      const level = Math.min(6, Math.max(1, numberAttr(node, "level", 1)));
      return `<h${level}>${children()}</h${level}>`;
    }
    case "blockquote": return `<blockquote>${children()}</blockquote>`;
    case "list": {
      const ordered = booleanAttr(node, "ordered");
      const start = numberAttr(node, "start", 1);
      return ordered ? `<ol${start === 1 ? "" : ` start=\"${start}\"`}>${children()}</ol>` : `<ul>${children()}</ul>`;
    }
    case "listItem": {
      const checked = node.attrs?.checked;
      const checkbox = typeof checked === "boolean" ? `<input type="checkbox" disabled${checked ? " checked" : ""} aria-hidden="true">` : "";
      return `<li>${checkbox}${children()}</li>`;
    }
    case "codeBlock": {
      const language = stringAttr(node, "language");
      return `<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${escapeHtml(node.text ?? "")}</code></pre>`;
    }
    case "inlineCode": return `<code>${escapeHtml(node.text ?? "")}</code>`;
    case "thematicBreak": return "<hr>";
    case "hardBreak": return "<br>";
    case "strong": return `<strong>${children()}</strong>`;
    case "emphasis": return `<em>${children()}</em>`;
    case "delete": return `<del>${children()}</del>`;
    case "link": {
      const url = stringAttr(node, "url");
      const policy = { ...DEFAULT_LINKS, ...(context.policy.links ?? {}) };
      if (!validateUrl(url, policy)) {
        pushUnsafeUrl(context, node, "link", url);
        return `<span data-mdfn-blocked-link="true">${children()}</span>`;
      }
      const title = stringAttr(node, "title");
      const external = isExternal(url);
      const target = external && policy.externalTarget ? ` target="${policy.externalTarget}"` : "";
      const rel = external && policy.externalRel ? ` rel="${escapeHtml(policy.externalRel)}"` : "";
      return `<a href="${escapeHtml(url)}"${title ? ` title="${escapeHtml(title)}"` : ""}${target}${rel}>${children()}</a>`;
    }
    case "image": {
      const url = stringAttr(node, "url");
      const policy = { ...DEFAULT_IMAGES, ...(context.policy.images ?? {}) };
      if (!validateUrl(url, { ...policy, allowProtocolRelative: false })) {
        pushUnsafeUrl(context, node, "image", url);
        return `<span data-mdfn-blocked-image="true">${escapeHtml(stringAttr(node, "alt"))}</span>`;
      }
      return `<img src="${escapeHtml(url)}" alt="${escapeHtml(stringAttr(node, "alt"))}"${stringAttr(node, "title") ? ` title="${escapeHtml(stringAttr(node, "title"))}"` : ""} loading="${policy.loading}" decoding="${policy.decoding}">`;
    }
    case "table": return `<table><tbody>${children()}</tbody></table>`;
    case "tableRow": return `<tr>${children()}</tr>`;
    case "tableCell": return `<td>${children()}</td>`;
    case "opaque": {
      const syntax = stringAttr(node, "syntax") || "unknown";
      const raw = node.source?.raw ?? node.text ?? "";
      if (syntax === "html" && context.policy.rawHtml?.enabled) {
        if (!context.policy.rawHtml.sanitize) throw new Error("MDFN_RAW_HTML_SANITIZER_REQUIRED");
        return context.policy.rawHtml.sanitize(raw);
      }
      return `<pre data-mdfn-opaque="${escapeHtml(syntax)}"><code>${escapeHtml(raw)}</code></pre>`;
    }
    default:
      context.diagnostics.push({ code: "MDFN_RENDER_NODE_UNSUPPORTED", message: `Node ${node.type} has no renderer`, severity: "warning", nodeId: node.id });
      return `<span data-mdfn-unsupported="${escapeHtml(node.type)}">${children()}</span>`;
  }
}

export function renderHtml(document: MdfnDocument, policy: RenderPolicy = {}): RenderResult {
  const context: RenderContext = { policy, registry: resolveRegistry(policy), diagnostics: [], nodeCount: 0 };
  const html = document.content.map((node) => renderNode(node, context, 1)).join("");
  const maxOutputBytes = policy.maxOutputBytes ?? 8 * 1024 * 1024;
  if (new TextEncoder().encode(html).byteLength > maxOutputBytes) throw new RangeError(`MDFN_RENDER_OUTPUT_TOO_LARGE:${maxOutputBytes}`);
  return { html, diagnostics: context.diagnostics, nodeCount: context.nodeCount };
}

export function renderTree(document: MdfnDocument): RenderTreeNode {
  const convert = (node: MdfnNode): RenderTreeNode => ({
    type: node.type,
    attrs: node.attrs,
    text: node.text,
    children: node.content?.map(convert),
  });
  return { type: "doc", children: document.content.map(convert) };
}

function plainText(node: MdfnNode): string {
  if (node.type === "text" || node.type === "inlineCode" || node.type === "codeBlock") return node.text ?? "";
  if (node.type === "image") return stringAttr(node, "alt");
  if (node.type === "opaque") return "";
  const separator = ["paragraph", "heading", "blockquote", "listItem", "tableRow"].includes(node.type) ? "\n" : "";
  return (node.content ?? []).map(plainText).join("") + separator;
}

export function extractPlainText(document: MdfnDocument): string {
  return document.content.map(plainText).join("").replace(/\n{3,}/g, "\n\n").trim();
}

export function extractHeadings(document: MdfnDocument): Array<{ level: number; text: string; nodeId?: string }> {
  const headings: Array<{ level: number; text: string; nodeId?: string }> = [];
  const visit = (node: MdfnNode): void => {
    if (node.type === "heading") headings.push({ level: numberAttr(node, "level", 1), text: plainText(node).trim(), nodeId: node.id });
    node.content?.forEach(visit);
  };
  visit(document);
  return headings;
}

export function extractLinks(document: MdfnDocument): Array<{ url: string; text: string; nodeId?: string }> {
  const links: Array<{ url: string; text: string; nodeId?: string }> = [];
  const visit = (node: MdfnNode): void => {
    if (node.type === "link") links.push({ url: stringAttr(node, "url"), text: plainText(node), nodeId: node.id });
    node.content?.forEach(visit);
  };
  visit(document);
  return links;
}

export function extractChunks(document: MdfnDocument, maxCharacters = 2_000): Array<{ text: string; heading?: string }> {
  const chunks: Array<{ text: string; heading?: string }> = [];
  let heading: string | undefined;
  let buffer = "";
  const flush = (): void => {
    const text = buffer.trim();
    if (text) chunks.push({ text, heading });
    buffer = "";
  };
  for (const node of document.content) {
    if (node.type === "heading") {
      flush();
      heading = plainText(node).trim();
      continue;
    }
    const text = plainText(node).trim();
    if (!text) continue;
    if (buffer && buffer.length + text.length + 2 > maxCharacters) flush();
    buffer += `${buffer ? "\n\n" : ""}${text}`;
  }
  flush();
  return chunks;
}

export interface ExtractedDocument {
  readonly plainText: string;
  readonly headings: readonly { readonly level: number; readonly text: string; readonly nodeId?: string }[];
  readonly links: readonly { readonly url: string; readonly text: string; readonly nodeId?: string }[];
  readonly chunks: readonly {
    readonly text: string;
    readonly headingPath: readonly string[];
    readonly links: readonly { readonly url: string; readonly text: string; readonly nodeId?: string }[];
  }[];
}

export function extractDocument(document: MdfnDocument, options: { readonly maxChunkLength?: number } = {}): ExtractedDocument {
  const maxChunkLength = Math.max(64, options.maxChunkLength ?? 2_000);
  const headings = extractHeadings(document);
  const links = extractLinks(document);
  const headingPath: string[] = [];
  const chunks: Array<ExtractedDocument["chunks"][number]> = [];
  let text = "";
  let chunkLinks: ExtractedDocument["chunks"][number]["links"] = [];
  const flush = (): void => {
    const value = text.trim();
    if (value) chunks.push({ text: value, headingPath: Object.freeze([...headingPath]), links: Object.freeze([...chunkLinks]) });
    text = "";
    chunkLinks = [];
  };
  for (const node of document.content) {
    if (node.type === "heading") {
      flush();
      const level = numberAttr(node, "level", 1);
      headingPath.length = Math.max(0, level - 1);
      headingPath[level - 1] = plainText(node).trim();
      continue;
    }
    const value = plainText(node).trim();
    if (!value) continue;
    if (text && text.length + value.length + 2 > maxChunkLength) flush();
    text += `${text ? "\n\n" : ""}${value}`;
    const visitLinks = (candidate: MdfnNode): void => {
      if (candidate.type === "link") chunkLinks = [...chunkLinks, { url: stringAttr(candidate, "url"), text: plainText(candidate), nodeId: candidate.id }];
      candidate.content?.forEach(visitLinks);
    };
    visitLinks(node);
  }
  flush();
  return { plainText: extractPlainText(document), headings, links, chunks };
}

export const MDFN_RENDER_VERSION = "0.1.0" as const;
