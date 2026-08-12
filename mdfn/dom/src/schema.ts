import type { MdfnDocument, MdfnJsonValue, MdfnMark, MdfnNode, SourceSpan } from "@mdfn/core";
import { Schema, type DOMOutputSpec, type Mark, type Node as PmNode, type NodeSpec } from "prosemirror-model";
import { tableNodes } from "prosemirror-tables";

const sourceAttrs = {
  mdfnFrom: { default: null },
  mdfnTo: { default: null },
  mdfnRaw: { default: null },
  mdfnPreservation: { default: null },
} as const;

const attrsFromSource = (source: SourceSpan | undefined): Record<string, unknown> => ({
  mdfnFrom: source?.from ?? null,
  mdfnTo: source?.to ?? null,
  mdfnRaw: source?.raw ?? null,
  mdfnPreservation: source?.preservation ?? null,
});

const block = (spec: NodeSpec): NodeSpec => ({ ...spec, attrs: { ...sourceAttrs, ...(spec.attrs ?? {}) } });
const tables = tableNodes({ tableGroup: "block", cellContent: "block+", cellAttributes: {} });

export const mdfnSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: block({ content: "inline*", group: "block", parseDOM: [{ tag: "p" }], toDOM: () => ["p", 0] }),
    heading: block({ attrs: { ...sourceAttrs, level: { default: 1 } }, content: "inline*", group: "block", defining: true, parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })), toDOM: (node) => [`h${node.attrs.level}`, 0] }),
    blockquote: block({ content: "block+", group: "block", defining: true, parseDOM: [{ tag: "blockquote" }], toDOM: () => ["blockquote", 0] }),
    horizontal_rule: block({ group: "block", parseDOM: [{ tag: "hr" }], toDOM: () => ["hr"] }),
    code_block: block({ attrs: { ...sourceAttrs, language: { default: "" }, meta: { default: "" } }, content: "text*", marks: "", group: "block", code: true, defining: true, parseDOM: [{ tag: "pre", preserveWhitespace: "full" }], toDOM: (node) => ["pre", ["code", node.attrs.language ? { class: `language-${node.attrs.language}` } : {}, 0]] }),
    bullet_list: block({ content: "list_item+", group: "block", parseDOM: [{ tag: "ul" }], toDOM: () => ["ul", 0] }),
    ordered_list: block({ attrs: { ...sourceAttrs, order: { default: 1 } }, content: "list_item+", group: "block", parseDOM: [{ tag: "ol", getAttrs: (element) => ({ order: (element as HTMLOListElement).start || 1 }) }], toDOM: (node) => node.attrs.order === 1 ? ["ol", 0] : ["ol", { start: node.attrs.order }, 0] }),
    list_item: { attrs: { checked: { default: null } }, content: "paragraph block*", defining: true, parseDOM: [{ tag: "li" }], toDOM: (node) => ["li", node.attrs.checked === null ? {} : { "data-checked": String(node.attrs.checked) }, 0] },
    image: { inline: true, attrs: { src: {}, alt: { default: "" }, title: { default: "" } }, group: "inline", draggable: true, parseDOM: [{ tag: "img[src]", getAttrs: (element) => { const image = element as HTMLImageElement; return { src: image.getAttribute("src"), alt: image.getAttribute("alt") ?? "", title: image.getAttribute("title") ?? "" }; } }], toDOM: (node) => ["img", node.attrs] },
    hard_break: { inline: true, group: "inline", selectable: false, parseDOM: [{ tag: "br" }], toDOM: () => ["br"] },
    opaque_block: block({ attrs: { ...sourceAttrs, syntax: { default: "unknown" }, raw: { default: "" } }, group: "block", atom: true, selectable: true, draggable: false, parseDOM: [{ tag: "pre[data-mdfn-opaque]", getAttrs: (element) => ({ syntax: (element as HTMLElement).dataset.mdfnOpaque, raw: element.textContent ?? "" }) }], toDOM: (node) => ["pre", { "data-mdfn-opaque": node.attrs.syntax, contenteditable: "false" }, ["code", String(node.attrs.raw)]] }),
    table: { ...tables.table, attrs: { ...sourceAttrs, ...(tables.table.attrs ?? {}) } },
    table_row: tables.table_row,
    table_cell: tables.table_cell,
    table_header: tables.table_header,
    text: { group: "inline" },
  },
  marks: {
    strong: { parseDOM: [{ tag: "strong" }, { tag: "b", getAttrs: (element) => (element as HTMLElement).style.fontWeight !== "normal" && null }], toDOM: () => ["strong", 0] },
    em: { parseDOM: [{ tag: "em" }, { tag: "i" }], toDOM: () => ["em", 0] },
    code: { parseDOM: [{ tag: "code" }], toDOM: () => ["code", 0] },
    link: { attrs: { href: {}, title: { default: "" } }, inclusive: false, parseDOM: [{ tag: "a[href]", getAttrs: (element) => ({ href: (element as HTMLAnchorElement).getAttribute("href"), title: (element as HTMLAnchorElement).getAttribute("title") ?? "" }) }], toDOM: (mark) => ["a", { href: mark.attrs.href, title: mark.attrs.title || null }, 0] },
    strike: { parseDOM: [{ tag: "del" }, { tag: "s" }], toDOM: () => ["del", 0] },
  },
});

function marksFor(node: MdfnNode, active: readonly Mark[]): readonly Mark[] {
  if (node.type === "strong") return [...active, mdfnSchema.marks.strong.create()];
  if (node.type === "emphasis") return [...active, mdfnSchema.marks.em.create()];
  if (node.type === "delete") return [...active, mdfnSchema.marks.strike.create()];
  if (node.type === "inlineCode") return [...active, mdfnSchema.marks.code.create()];
  if (node.type === "link") return [...active, mdfnSchema.marks.link.create({ href: String(node.attrs?.url ?? ""), title: String(node.attrs?.title ?? "") })];
  return active;
}

function inlineNodes(nodes: readonly MdfnNode[] | undefined, active: readonly Mark[] = []): PmNode[] {
  return (nodes ?? []).flatMap((node) => {
    const marks = marksFor(node, active);
    if (node.type === "text" || node.type === "inlineCode") return node.text ? [mdfnSchema.text(node.text, marks)] : [];
    if (node.type === "image") return [mdfnSchema.nodes.image.create({ src: String(node.attrs?.url ?? ""), alt: String(node.attrs?.alt ?? ""), title: String(node.attrs?.title ?? "") }, undefined, marks)];
    if (node.type === "hardBreak") return [mdfnSchema.nodes.hard_break.create(undefined, undefined, marks)];
    return inlineNodes(node.content, marks);
  });
}

function blockNode(node: MdfnNode): PmNode {
  const source = attrsFromSource(node.source);
  switch (node.type) {
    case "paragraph": return mdfnSchema.nodes.paragraph.create(source, inlineNodes(node.content));
    case "heading": return mdfnSchema.nodes.heading.create({ ...source, level: Number(node.attrs?.level ?? 1) }, inlineNodes(node.content));
    case "blockquote": return mdfnSchema.nodes.blockquote.create(source, (node.content ?? []).map(blockNode));
    case "thematicBreak": return mdfnSchema.nodes.horizontal_rule.create(source);
    case "codeBlock": return mdfnSchema.nodes.code_block.create({ ...source, language: String(node.attrs?.language ?? ""), meta: String(node.attrs?.meta ?? "") }, node.text ? mdfnSchema.text(node.text) : undefined);
    case "list": {
      const ordered = node.attrs?.ordered === true;
      return (ordered ? mdfnSchema.nodes.ordered_list : mdfnSchema.nodes.bullet_list).create(ordered ? { ...source, order: Number(node.attrs?.start ?? 1) } : source, (node.content ?? []).map(blockNode));
    }
    case "listItem": {
      const childBlocks = (node.content ?? []).map((child) => child.type === "paragraph" ? blockNode(child) : blockNode(child));
      const content = childBlocks.length > 0 ? childBlocks : [mdfnSchema.nodes.paragraph.create()];
      return mdfnSchema.nodes.list_item.create({ checked: typeof node.attrs?.checked === "boolean" ? node.attrs.checked : null }, content);
    }
    case "table": return mdfnSchema.nodes.table.create(source, (node.content ?? []).map(blockNode));
    case "tableRow": return mdfnSchema.nodes.table_row.create(undefined, (node.content ?? []).map(blockNode));
    case "tableCell": return mdfnSchema.nodes.table_cell.create(undefined, (node.content ?? []).map((child) => child.type === "paragraph" ? blockNode(child) : mdfnSchema.nodes.paragraph.create(undefined, inlineNodes([child]))));
    case "opaque": return mdfnSchema.nodes.opaque_block.create({ ...source, syntax: String(node.attrs?.syntax ?? "unknown"), raw: node.source?.raw ?? node.text ?? "" });
    default: return mdfnSchema.nodes.paragraph.create(source, inlineNodes(node.content ?? [node]));
  }
}

export function documentToProseMirror(document: MdfnDocument): PmNode {
  const content = document.content.map(blockNode);
  return mdfnSchema.nodes.doc.create(undefined, content.length > 0 ? content : [mdfnSchema.nodes.paragraph.create()]);
}

function sourceFromAttrs(node: PmNode, dirty: boolean): SourceSpan | undefined {
  const from = node.attrs.mdfnFrom;
  const to = node.attrs.mdfnTo;
  if (typeof from !== "number" || typeof to !== "number") return undefined;
  return {
    from,
    to,
    raw: typeof node.attrs.mdfnRaw === "string" ? node.attrs.mdfnRaw : undefined,
    preservation: ["exact", "semantic", "opaque"].includes(node.attrs.mdfnPreservation) ? node.attrs.mdfnPreservation : "semantic",
    dirty,
  };
}

function wrapMarks(node: MdfnNode, marks: readonly Mark[]): MdfnNode {
  return marks.reduceRight<MdfnNode>((content, mark) => {
    if (mark.type === mdfnSchema.marks.strong) return { type: "strong", content: [content] };
    if (mark.type === mdfnSchema.marks.em) return { type: "emphasis", content: [content] };
    if (mark.type === mdfnSchema.marks.code) {
      const text = content.text ?? content.content?.map((child) => child.text ?? "").join("") ?? "";
      return { type: "inlineCode", text };
    }
    if (mark.type === mdfnSchema.marks.strike) return { type: "delete", content: [content] };
    if (mark.type === mdfnSchema.marks.link) return { type: "link", attrs: { url: String(mark.attrs.href), title: String(mark.attrs.title ?? "") }, content: [content] };
    return content;
  }, node);
}

function inlineFromPm(node: PmNode): MdfnNode[] {
  const output: MdfnNode[] = [];
  node.forEach((child) => {
    if (child.isText) output.push(wrapMarks({ type: "text", text: child.text ?? "" }, child.marks));
    else if (child.type === mdfnSchema.nodes.image) output.push(wrapMarks({ type: "image", attrs: { url: child.attrs.src, alt: child.attrs.alt, title: child.attrs.title } as Record<string, MdfnJsonValue> }, child.marks));
    else if (child.type === mdfnSchema.nodes.hard_break) output.push({ type: "hardBreak" });
  });
  return output;
}

function pmToBlock(node: PmNode, dirty: boolean): MdfnNode {
  const source = sourceFromAttrs(node, dirty);
  if (node.type === mdfnSchema.nodes.paragraph) return { type: "paragraph", source, content: inlineFromPm(node) };
  if (node.type === mdfnSchema.nodes.heading) return { type: "heading", source, attrs: { level: node.attrs.level }, content: inlineFromPm(node) };
  if (node.type === mdfnSchema.nodes.blockquote) return { type: "blockquote", source, content: node.content.content.map((child) => pmToBlock(child, dirty)) };
  if (node.type === mdfnSchema.nodes.horizontal_rule) return { type: "thematicBreak", source };
  if (node.type === mdfnSchema.nodes.code_block) return { type: "codeBlock", source, text: node.textContent, attrs: { language: node.attrs.language, meta: node.attrs.meta } };
  if (node.type === mdfnSchema.nodes.bullet_list || node.type === mdfnSchema.nodes.ordered_list) return { type: "list", source, attrs: { ordered: node.type === mdfnSchema.nodes.ordered_list, start: node.attrs.order ?? 1 }, content: node.content.content.map((child) => pmToBlock(child, dirty)) };
  if (node.type === mdfnSchema.nodes.list_item) return { type: "listItem", attrs: { checked: node.attrs.checked }, content: node.content.content.map((child) => pmToBlock(child, dirty)) };
  if (node.type === mdfnSchema.nodes.table) return { type: "table", source, content: node.content.content.map((child) => pmToBlock(child, dirty)) };
  if (node.type === mdfnSchema.nodes.table_row) return { type: "tableRow", content: node.content.content.map((child) => pmToBlock(child, dirty)) };
  if (node.type === mdfnSchema.nodes.table_cell || node.type === mdfnSchema.nodes.table_header) return { type: "tableCell", content: node.content.content.map((child) => pmToBlock(child, dirty)) };
  if (node.type === mdfnSchema.nodes.opaque_block) return { type: "opaque", source, text: node.attrs.raw, attrs: { syntax: node.attrs.syntax } };
  return { type: "paragraph", source, content: inlineFromPm(node) };
}

export function proseMirrorToDocument(current: PmNode, previous?: PmNode, schemaVersion = 1): MdfnDocument {
  const content = current.content.content.map((child, index) => {
    const previousChild = previous && index < previous.childCount ? previous.child(index) : undefined;
    const dirty = !previousChild || !child.eq(previousChild);
    return pmToBlock(child, dirty);
  });
  return { type: "doc", schemaVersion, content };
}
