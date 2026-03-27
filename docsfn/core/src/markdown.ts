import { marked } from "marked";
import { transformFumadocsV15 } from "./compat/fumadocs";
import { createDiagnostic, createDocsError, type DocsError } from "./diagnostics";
import { assertSafeSource } from "./sanitize";
import type {
  CompiledContentArtifact,
  CompiledContentBlock,
  CompiledListBlock,
  CompiledTableBlock,
  CompiledTabsBlock,
  DocHeading,
  DocsCompatPreset,
  DocsDiagnostic,
} from "./types";

type CompileFramework = "core" | "react" | "svelte";

export interface CompileMarkdownInput {
  source: string;
  sourcePath?: string;
  framework?: CompileFramework;
  compatPreset?: DocsCompatPreset;
  allowRawHtml?: boolean;
}

const HEADING_REGEX = /^(#{1,6})\s+(.*)$/;
const CODE_FENCE_REGEX = /^```/;
const TABS_START_REGEX = /^<\s*(DocsTabs|Tabs)\b([^>]*)>/;
const TABS_END_REGEX = /^<\s*\/\s*(DocsTabs|Tabs)\s*>/;
const TAB_START_REGEX = /^<\s*(DocsTab|Tab)\b([^>]*)>/;
const TAB_END_REGEX = /^<\s*\/\s*(DocsTab|Tab)\s*>/;
const CALLOUT_REGEX = /^>\s*\[!(NOTE|TIP|WARNING|INFO|CAUTION)\]\s*(.*)$/i;
const COMPONENT_SELF_CLOSING_REGEX = /^<\s*([A-Z][A-Za-z0-9]*)\b[^>]*\/>\s*$/;
const COMPONENT_START_REGEX = /^<\s*([A-Z][A-Za-z0-9]*)\b[^>]*>\s*$/;
const LIST_UNORDERED_REGEX = /^[-*+]\s+/;
const LIST_ORDERED_REGEX = /^\d+[.)]\s+/;
const TABLE_ROW_REGEX = /^\|.+\|/;

const UNSAFE_HREF_RE = /(\bhref\s*=\s*["'])\s*javascript:[^"']*/gi;
const EVENT_ATTR_RE = /\s+on[a-z][a-z0-9]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi;

interface ParseBlocksOptions {
  source: string;
  sourcePath?: string;
  resolvedComponents?: Set<string>;
  idPrefix?: string;
}

function normalizeSourceSnippet(value: string): string {
  return value.trim();
}

function normalizeRouteLikeId(value: string | undefined, fallback: string): string {
  const candidate = (value ?? fallback).replaceAll("\\", "/");
  return candidate.replace(/[^a-zA-Z0-9/_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function createMermaidId(input: {
  idPrefix?: string;
  sourcePath?: string;
  count: number;
}): string {
  const pathPart = normalizeRouteLikeId(input.idPrefix ?? input.sourcePath, "inline");
  return `mermaid-${pathPart}-${String(input.count).padStart(2, "0")}`;
}

function parseComponentProps(rawAttributes: string): Record<string, string | number | boolean> {
  const props: Record<string, string | number | boolean> = {};
  const pattern =
    /([A-Za-z_][A-Za-z0-9_:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}))?/g;

  for (const match of rawAttributes.matchAll(pattern)) {
    const key = match[1];
    if (!key) {
      continue;
    }

    const stringValue = match[2] ?? match[3];
    const expressionValue = match[4]?.trim();
    if (stringValue !== undefined) {
      props[key] = stringValue;
      continue;
    }
    if (expressionValue === undefined) {
      props[key] = true;
      continue;
    }
    if (expressionValue === "true") {
      props[key] = true;
      continue;
    }
    if (expressionValue === "false") {
      props[key] = false;
      continue;
    }
    if (/^-?\d+(?:\.\d+)?$/.test(expressionValue)) {
      props[key] = Number(expressionValue);
      continue;
    }
    props[key] = expressionValue.replace(/^['"]|['"]$/g, "");
  }

  return props;
}

function sanitizeMarkdownHtml(html: string): string {
  return html
    .replace(UNSAFE_HREF_RE, "$1#")
    .replace(EVENT_ATTR_RE, "");
}

function renderInlineHtml(text: string): string {
  return sanitizeMarkdownHtml(marked.parseInline(text, { async: false }) as string);
}

function renderBlockHtml(text: string): string {
  return sanitizeMarkdownHtml(marked.parse(text.trim(), { async: false }) as string);
}

const UNICODE_SLUG_MAP: Record<string, string> = {
  日: "ri-",
  本: "ben-",
  語: "yu-",
  の: "no",
  ヘ: "he",
  テ: "d",
  デ: "d",
  ィ: "i",
  ン: "n",
  ク: "gu",
  グ: "gu",
};

function isDocsError(error: unknown): error is DocsError {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: string }).name === "DocsError"
  );
}

function createMdxCompileError(input: {
  message: string;
  sourcePath?: string;
  details?: Record<string, unknown>;
}): DocsError {
  return createDocsError({
    code: "DOCS_MDX_COMPILE_FAILED",
    message: input.message,
    diagnostics: [
      createDiagnostic({
        code: "DOCS_MDX_COMPILE_FAILED",
        message: input.message,
        location: { absolutePath: input.sourcePath },
        details: input.details,
      }),
    ],
  });
}

function normalizeSlugText(text: string): string {
  let candidate = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u3099\u309a]/g, "");
  let raw = "";
  for (const character of candidate) {
    if (UNICODE_SLUG_MAP[character]) {
      raw += UNICODE_SLUG_MAP[character];
      continue;
    }
    if (/[A-Za-z0-9]/.test(character)) {
      raw += character.toLowerCase();
      continue;
    }
    if (/[\s\-_/&()[\]{}.,:;!?'"`~+*<>=|\\]/.test(character)) {
      raw += "-";
      continue;
    }
    raw += `u${character.codePointAt(0)?.toString(16) ?? ""}-`;
  }

  const normalized = raw.replace(/-+/g, "-").replace(/(^-|-$)/g, "");
  return normalized || "section";
}

function createSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text: string) => {
    const base = normalizeSlugText(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}

function isListStart(line: string): boolean {
  const trimmed = line.trim();
  return LIST_UNORDERED_REGEX.test(trimmed) || LIST_ORDERED_REGEX.test(trimmed);
}

function isTableStart(line: string): boolean {
  return TABLE_ROW_REGEX.test(line.trim());
}

function isBlockStart(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length === 0 ||
    HEADING_REGEX.test(trimmed) ||
    CODE_FENCE_REGEX.test(trimmed) ||
    TABS_START_REGEX.test(trimmed) ||
    CALLOUT_REGEX.test(trimmed) ||
    COMPONENT_SELF_CLOSING_REGEX.test(trimmed) ||
    COMPONENT_START_REGEX.test(trimmed) ||
    isListStart(line) ||
    isTableStart(line)
  );
}

function parseTableBlock(input: {
  lines: string[];
  startIndex: number;
}): { block: CompiledTableBlock; nextIndex: number } {
  const rawLines: string[] = [];
  let index = input.startIndex;

  while (index < input.lines.length) {
    const trimmed = input.lines[index].trim();
    if (trimmed.length === 0 || !TABLE_ROW_REGEX.test(trimmed)) {
      break;
    }
    rawLines.push(input.lines[index]);
    index++;
  }

  const html = renderBlockHtml(rawLines.join("\n"));
  return { block: { type: "table", html }, nextIndex: index };
}

function parseListBlock(input: {
  lines: string[];
  startIndex: number;
}): { block: CompiledListBlock; nextIndex: number } {
  const firstTrimmed = input.lines[input.startIndex].trim();
  const ordered = LIST_ORDERED_REGEX.test(firstTrimmed);
  const rawLines: string[] = [];
  const items: Array<{ text: string }> = [];
  let index = input.startIndex;

  while (index < input.lines.length) {
    const rawLine = input.lines[index];
    const trimmed = rawLine.trim();

    if (trimmed.length === 0) {
      // Blank line: part of a loose list only if next non-blank is a list line or indented continuation
      let peek = index + 1;
      while (peek < input.lines.length && input.lines[peek].trim().length === 0) {
        peek++;
      }
      if (peek < input.lines.length) {
        const nextLine = input.lines[peek];
        const nextTrimmed = nextLine.trim();
        const nextIsListContinuation =
          LIST_UNORDERED_REGEX.test(nextTrimmed) ||
          LIST_ORDERED_REGEX.test(nextTrimmed) ||
          nextLine.startsWith("  ") ||
          nextLine.startsWith("\t");
        if (nextIsListContinuation) {
          rawLines.push(rawLine);
          index = peek;
          continue;
        }
      }
      break;
    }

    const isTopLevel =
      (LIST_UNORDERED_REGEX.test(trimmed) || LIST_ORDERED_REGEX.test(trimmed)) &&
      !rawLine.startsWith("  ") &&
      !rawLine.startsWith("\t");
    const isIndentedContinuation =
      (rawLine.startsWith("  ") || rawLine.startsWith("\t")) && rawLines.length > 0;

    if (!isTopLevel && !isIndentedContinuation) {
      break;
    }

    if (isTopLevel) {
      const text = trimmed
        .replace(LIST_UNORDERED_REGEX, "")
        .replace(LIST_ORDERED_REGEX, "")
        .trim();
      items.push({ text });
    }

    rawLines.push(rawLine);
    index++;
  }

  const html = renderBlockHtml(rawLines.join("\n"));
  return { block: { type: "list", ordered, items, html }, nextIndex: index };
}

function parseTabsItems(rawAttributes: string): string[] {
  const itemsMatch = rawAttributes.match(/items\s*=\s*\{(\[[^\]]*\])\}/);
  if (!itemsMatch) {
    return [];
  }

  const literal = itemsMatch[1].replaceAll("'", "\"");
  try {
    const parsed = JSON.parse(literal);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value) => typeof value === "string");
  } catch {
    return [];
  }
}

function parseTabsBlock(input: {
  lines: string[];
  startIndex: number;
  sourcePath?: string;
  resolvedComponents?: Set<string>;
}): { block: CompiledTabsBlock; nextIndex: number } {
  const startLine = input.lines[input.startIndex].trim();
  const startMatch = startLine.match(TABS_START_REGEX);
  if (!startMatch) {
    throw createMdxCompileError({
      message: "invalid tabs block start",
      sourcePath: input.sourcePath,
    });
  }

  const tabs: CompiledTabsBlock["tabs"] = [];
  const declaredItems = parseTabsItems(startMatch[2] ?? "");
  let index = input.startIndex + 1;
  let foundClosing = false;

  while (index < input.lines.length) {
    const line = input.lines[index].trim();
    if (TABS_END_REGEX.test(line)) {
      foundClosing = true;
      index += 1;
      break;
    }

    const tabStartMatch = line.match(TAB_START_REGEX);
    if (!tabStartMatch) {
      index += 1;
      continue;
    }

    const tabAttributes = tabStartMatch[2] ?? "";
    const valueMatch = tabAttributes.match(/value\s*=\s*["']([^"']+)["']/);
    const value = valueMatch?.[1];
    if (!value) {
      throw createMdxCompileError({
        message: "tab block is missing required value attribute",
        sourcePath: input.sourcePath,
      });
    }

    const inlineContentMatch = line.match(
      /<\s*(DocsTab|Tab)\b[^>]*>([\s\S]*?)<\s*\/\s*(DocsTab|Tab)\s*>/
    );
    if (inlineContentMatch) {
      const source = normalizeSourceSnippet(inlineContentMatch[2] ?? "");
      tabs.push({
        value,
        label: declaredItems.includes(value) ? value : undefined,
        source,
        content: source,
        nodes: parseBlocks({
          source,
          sourcePath: input.sourcePath,
          resolvedComponents: input.resolvedComponents,
          idPrefix: `${normalizeRouteLikeId(input.sourcePath, "inline")}-tab-${tabs.length}`,
        }),
      });
      index += 1;
      continue;
    }

    const contentLines: string[] = [];
    index += 1;
    let foundTabClose = false;
    while (index < input.lines.length) {
      const tabLine = input.lines[index];
      if (TAB_END_REGEX.test(tabLine.trim())) {
        foundTabClose = true;
        index += 1;
        break;
      }
      contentLines.push(tabLine);
      index += 1;
    }

    if (!foundTabClose) {
      throw createMdxCompileError({
        message: "tab block is missing a closing tag",
        sourcePath: input.sourcePath,
      });
    }

    const source = normalizeSourceSnippet(contentLines.join("\n"));
    tabs.push({
      value,
      label: declaredItems.includes(value) ? value : undefined,
      source,
      content: source,
      nodes: parseBlocks({
        source,
        sourcePath: input.sourcePath,
        resolvedComponents: input.resolvedComponents,
        idPrefix: `${normalizeRouteLikeId(input.sourcePath, "inline")}-tab-${tabs.length}`,
      }),
    });
  }

  if (!foundClosing) {
    throw createMdxCompileError({
      message: "tabs block is missing a closing tag",
      sourcePath: input.sourcePath,
    });
  }

  if (tabs.length === 0) {
    throw createMdxCompileError({
      message: "tabs block does not contain any tab items",
      sourcePath: input.sourcePath,
    });
  }

  const items = declaredItems.length > 0 ? declaredItems : tabs.map((tab) => tab.value);
  return {
    block: {
      type: "tabs",
      items,
      tabs,
    },
    nextIndex: index,
  };
}

function parseBlocks(input: ParseBlocksOptions): CompiledContentBlock[] {
  const lines = input.source.split(/\r?\n/);
  const blocks: CompiledContentBlock[] = [];
  const createHeadingSlug = createSlugger();
  let mermaidCount = 0;
  let index = 0;

  while (index < lines.length) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();

    if (trimmed.length === 0) {
      index += 1;
      continue;
    }

    if (CODE_FENCE_REGEX.test(trimmed)) {
      const lang = trimmed.slice(3).trim() || undefined;
      index += 1;
      const codeLines: string[] = [];
      let foundFenceClose = false;
      while (index < lines.length) {
        const codeLine = lines[index];
        if (CODE_FENCE_REGEX.test(codeLine.trim())) {
          foundFenceClose = true;
          index += 1;
          break;
        }
        codeLines.push(codeLine);
        index += 1;
      }
      if (!foundFenceClose) {
        throw createMdxCompileError({
          message: "code fence is missing a closing delimiter",
          sourcePath: input.sourcePath,
        });
      }
      const code = codeLines.join("\n");
      if (lang?.toLowerCase() === "mermaid") {
        mermaidCount += 1;
        blocks.push({
          type: "mermaid",
          id: createMermaidId({
            idPrefix: input.idPrefix,
            sourcePath: input.sourcePath,
            count: mermaidCount,
          }),
          code,
        });
      } else {
        blocks.push({ type: "code", lang, code });
      }
      continue;
    }

    const headingMatch = trimmed.match(HEADING_REGEX);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      blocks.push({
        type: "heading",
        level,
        text,
        html: renderInlineHtml(text),
        slug: createHeadingSlug(text),
      });
      index += 1;
      continue;
    }

    if (isListStart(trimmed)) {
      const parsedList = parseListBlock({ lines, startIndex: index });
      blocks.push(parsedList.block);
      index = parsedList.nextIndex;
      continue;
    }

    if (TABS_START_REGEX.test(trimmed)) {
      const parsedTabs = parseTabsBlock({
        lines,
        startIndex: index,
        sourcePath: input.sourcePath,
        resolvedComponents: input.resolvedComponents,
      });
      blocks.push(parsedTabs.block);
      index = parsedTabs.nextIndex;
      continue;
    }

    const calloutMatch = trimmed.match(CALLOUT_REGEX);
    if (calloutMatch) {
      const calloutLines: string[] = [];
      const firstLine = calloutMatch[2]?.trim() ?? "";
      if (firstLine) {
        calloutLines.push(firstLine);
      }
      index += 1;
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        const value = lines[index].replace(/^\s*>\s?/, "").trim();
        if (value) {
          calloutLines.push(value);
        }
        index += 1;
      }
      const calloutText = calloutLines.join("\n");
      blocks.push({
        type: "callout",
        kind: calloutMatch[1].toLowerCase() as "note" | "tip" | "warning" | "info" | "caution",
        text: calloutText,
        html: renderBlockHtml(calloutText),
      });
      continue;
    }

    const selfClosingComponentMatch = trimmed.match(COMPONENT_SELF_CLOSING_REGEX);
    if (selfClosingComponentMatch) {
      const componentName = selfClosingComponentMatch[1];
      if (
        input.resolvedComponents &&
        !input.resolvedComponents.has(componentName)
      ) {
        throw createDocsError({
          code: "DOCS_COMPONENT_UNRESOLVED",
          message: `component ${componentName} is not resolved in compatibility mode`,
          diagnostics: [
            createDiagnostic({
              code: "DOCS_COMPONENT_UNRESOLVED",
              message: `component ${componentName} is not resolved in compatibility mode`,
              location: { absolutePath: input.sourcePath },
              details: {
                component: componentName,
              },
            }),
          ],
        });
      }
      blocks.push({
        type: "component",
        name: componentName,
        props: parseComponentProps(
          trimmed.replace(/^<\s*[A-Z][A-Za-z0-9]*/, "").replace(/\/>\s*$/, "")
        ),
        source: "",
        body: undefined,
        selfClosing: true,
        children: [],
      });
      index += 1;
      continue;
    }

    const componentStartMatch = trimmed.match(COMPONENT_START_REGEX);
    if (componentStartMatch) {
      const componentName = componentStartMatch[1];
      if (
        input.resolvedComponents &&
        !input.resolvedComponents.has(componentName)
      ) {
        throw createDocsError({
          code: "DOCS_COMPONENT_UNRESOLVED",
          message: `component ${componentName} is not resolved in compatibility mode`,
          diagnostics: [
            createDiagnostic({
              code: "DOCS_COMPONENT_UNRESOLVED",
              message: `component ${componentName} is not resolved in compatibility mode`,
              location: { absolutePath: input.sourcePath },
              details: {
                component: componentName,
              },
            }),
          ],
        });
      }
      index += 1;
      const bodyLines: string[] = [];
      let foundComponentClose = false;
      const componentClosePattern = new RegExp(`^<\\s*\\/\\s*${componentName}\\s*>\\s*$`);
      while (index < lines.length) {
        const current = lines[index];
        if (componentClosePattern.test(current.trim())) {
          foundComponentClose = true;
          index += 1;
          break;
        }
        bodyLines.push(current);
        index += 1;
      }
      if (!foundComponentClose) {
        throw createMdxCompileError({
          message: `component ${componentName} is missing a closing tag`,
          sourcePath: input.sourcePath,
        });
      }
      const source = normalizeSourceSnippet(bodyLines.join("\n"));
      blocks.push({
        type: "component",
        name: componentName,
        props: parseComponentProps(
          trimmed.replace(/^<\s*[A-Z][A-Za-z0-9]*/, "").replace(/>\s*$/, "")
        ),
        source,
        body: source,
        selfClosing: false,
        children: parseBlocks({
          source,
          sourcePath: input.sourcePath,
          resolvedComponents: input.resolvedComponents,
          idPrefix: `${normalizeRouteLikeId(input.sourcePath, "inline")}-component-${componentName}`,
        }),
      });
      continue;
    }

    if (isTableStart(trimmed)) {
      const parsedTable = parseTableBlock({ lines, startIndex: index });
      blocks.push(parsedTable.block);
      index = parsedTable.nextIndex;
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length && !isBlockStart(lines[index])) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    if (paragraphLines.length > 0) {
      const paragraphText = paragraphLines.join(" ").trim();
      blocks.push({
        type: "paragraph",
        text: paragraphText,
        html: renderInlineHtml(paragraphText),
      });
      continue;
    }

    index += 1;
  }

  return blocks;
}

export function extractHeadings(markdown: string): DocHeading[] {
  const lines = markdown.split(/\r?\n/);
  const headings: DocHeading[] = [];
  const createSlug = createSlugger();
  let insideCodeFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (CODE_FENCE_REGEX.test(trimmed)) {
      insideCodeFence = !insideCodeFence;
      continue;
    }

    if (insideCodeFence) {
      continue;
    }

    const match = trimmed.match(HEADING_REGEX);
    if (!match) {
      continue;
    }

    const text = match[2].trim();
    headings.push({
      level: match[1].length,
      text,
      slug: createSlug(text),
    });
  }

  return headings;
}

export function compileMarkdown(input: CompileMarkdownInput): CompiledContentArtifact {
  try {
    const framework = input.framework ?? "core";
    let transformedSource = input.source;
    const componentsUsed = new Set<string>();
    let resolvedComponents: Set<string> | undefined;

    if (input.compatPreset === "fumadocs-v15") {
      const compat = transformFumadocsV15({
        source: transformedSource,
        sourcePath: input.sourcePath,
      });
      transformedSource = compat.transformed;
      resolvedComponents = compat.importedComponents;
      for (const componentName of compat.componentsUsed) {
        componentsUsed.add(componentName);
      }
    }

    assertSafeSource({
      source: transformedSource,
      sourcePath: input.sourcePath,
      allowRawHtml: input.allowRawHtml,
    });

    const blocks = parseBlocks({
      source: transformedSource,
      sourcePath: input.sourcePath,
      resolvedComponents,
      idPrefix: normalizeRouteLikeId(input.sourcePath, "inline"),
    });
    const headings = blocks
      .filter((block): block is Extract<CompiledContentBlock, { type: "heading" }> => block.type === "heading")
      .map((block) => ({
        level: block.level,
        text: block.text,
        slug: block.slug,
      }));

    if (blocks.some((block) => block.type === "tabs")) {
      componentsUsed.add("DocsTabs");
      componentsUsed.add("DocsTab");
    }
    if (blocks.some((block) => block.type === "mermaid")) {
      componentsUsed.add("MermaidBlock");
    }
    if (blocks.some((block) => block.type === "callout")) {
      componentsUsed.add("Callout");
    }

    return {
      framework,
      renderModelVersion: 2,
      source: input.source,
      transformedSource,
      blocks,
      headings,
      toc: headings,
      componentsUsed: [...componentsUsed].sort((left, right) => left.localeCompare(right)),
      diagnostics: [],
    };
  } catch (error) {
    if (isDocsError(error)) {
      throw error;
    }
    throw createMdxCompileError({
      message: "failed to compile markdown content",
      sourcePath: input.sourcePath,
      details: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

export type {
  CompiledContentArtifact,
  CompiledContentBlock,
} from "./types";
