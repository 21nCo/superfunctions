import type { MdfnDiagnostic, MdfnSidecar, MdfnSnapshot } from "@mdfn/core";

export interface MarkdownContentProfile {
  readonly id: string;
  readonly dialect: "commonmark" | "gfm";
  readonly allowRawHtml: boolean;
  readonly extensions: readonly string[];
  readonly schemaVersion: number;
}

export interface MarkdownContent {
  readonly type: "text/markdown";
  readonly version: 1;
  readonly markdown: string;
  readonly profile: MarkdownContentProfile;
  readonly schemaHash?: string;
  readonly sidecar?: MdfnSidecar;
}

export const defaultMarkdownContentProfile: MarkdownContentProfile = Object.freeze({
  id: "mdfn:gfm",
  dialect: "gfm",
  allowRawHtml: false,
  extensions: Object.freeze([]),
  schemaVersion: 1,
});

export function markdownContent(
  markdown: string,
  options: Partial<Omit<MarkdownContent, "type" | "version" | "markdown">> = {},
): MarkdownContent {
  return Object.freeze({
    type: "text/markdown",
    version: 1,
    markdown,
    profile: Object.freeze({ ...defaultMarkdownContentProfile, ...(options.profile ?? {}) }),
    schemaHash: options.schemaHash,
    sidecar: options.sidecar,
  });
}

export function snapshotToContent(snapshot: MdfnSnapshot, profile: MarkdownContentProfile = defaultMarkdownContentProfile): MarkdownContent {
  return markdownContent(snapshot.markdown, { profile, schemaHash: snapshot.schemaHash, sidecar: snapshot.sidecar });
}

export function isMarkdownContent(value: unknown): value is MarkdownContent {
  const candidate = value as Partial<MarkdownContent> | null;
  return candidate?.type === "text/markdown" && candidate.version === 1 && typeof candidate.markdown === "string" && !!candidate.profile;
}

export interface ContentMigrationDiagnostic {
  readonly code: "MDFN_CONTENT_MIGRATED_STRING" | "MDFN_CONTENT_MIGRATED_LEGACY_MARKDOWN" | "MDFN_CONTENT_RICHTEXT_LOSSY" | "MDFN_CONTENT_UNSUPPORTED";
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly path?: string;
}

export interface ContentMigrationResult {
  readonly content: MarkdownContent;
  readonly diagnostics: readonly ContentMigrationDiagnostic[];
  readonly lossy: boolean;
}

function textFromRichNode(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const node = value as Record<string, unknown>;
  if (typeof node.text === "string") return node.text;
  return Array.isArray(node.children) ? node.children.map(textFromRichNode).join("") : "";
}

function opaqueMigrationComment(value: unknown): string {
  const visited = new WeakSet<object>();
  let serialized: string;
  try {
    serialized = JSON.stringify(value, (_key, entry: unknown) => {
      if (typeof entry === "bigint") return { $mdfnType: "bigint", value: entry.toString() };
      if (entry && typeof entry === "object") {
        if (visited.has(entry)) return { $mdfnType: "circular" };
        visited.add(entry);
      }
      return entry;
    }) ?? String(value);
  } catch {
    serialized = String(value);
  }

  // Percent encoding makes the retained payload inert inside an HTML comment.
  // Hyphens are encoded separately because encodeURIComponent leaves them bare.
  const encoded = encodeURIComponent(serialized).replaceAll("-", "%2D");
  return `<!-- mdfn-migration-opaque:${encoded} -->`;
}

function richBlocksToMarkdown(value: readonly unknown[]): { markdown: string; unsupported: number } {
  let unsupported = 0;
  const blocks = value.map((entry) => {
    if (!entry || typeof entry !== "object") { unsupported += 1; return opaqueMigrationComment(entry); }
    const block = entry as Record<string, unknown>;
    const type = typeof block.type === "string" ? block.type : "paragraph";
    const text = textFromRichNode(block);
    if (type === "paragraph") return text;
    if (/^h[1-6]$/.test(type)) return `${"#".repeat(Number(type[1]))} ${text}`;
    if (type === "blockquote") return text.split("\n").map((line) => `> ${line}`).join("\n");
    if (type === "code") return `\`\`\`${typeof block.language === "string" ? block.language : ""}\n${text}\n\`\`\``;
    if (type === "list-item") return `- ${text}`;
    unsupported += 1;
    return opaqueMigrationComment(entry);
  });
  return { markdown: blocks.join("\n\n"), unsupported };
}

export function migrateToMarkdownContent(
  value: unknown,
  profile: MarkdownContentProfile = defaultMarkdownContentProfile,
): ContentMigrationResult {
  if (isMarkdownContent(value)) {
    return { content: value, diagnostics: [], lossy: false };
  }
  if (typeof value === "string") {
    return {
      content: markdownContent(value, { profile }),
      diagnostics: [{ code: "MDFN_CONTENT_MIGRATED_STRING", severity: "info", message: "Legacy string was wrapped as versioned Markdown content" }],
      lossy: false,
    };
  }
  if (value && typeof value === "object" && (value as { type?: unknown }).type === "text/markdown" && typeof (value as { markdown?: unknown }).markdown === "string") {
    const legacy = value as { markdown: string; schemaHash?: string; sidecar?: MdfnSidecar };
    return {
      content: markdownContent(legacy.markdown, { profile, schemaHash: legacy.schemaHash, sidecar: legacy.sidecar }),
      diagnostics: [{ code: "MDFN_CONTENT_MIGRATED_LEGACY_MARKDOWN", severity: "info", message: "Legacy Markdown envelope was upgraded to version 1 with an explicit profile" }],
      lossy: false,
    };
  }
  if (Array.isArray(value)) {
    const projected = richBlocksToMarkdown(value);
    return {
      content: markdownContent(projected.markdown, { profile }),
      diagnostics: projected.unsupported > 0 ? [{ code: "MDFN_CONTENT_RICHTEXT_LOSSY", severity: "warning", message: `${projected.unsupported} rich-text blocks were retained as opaque migration comments` }] : [],
      lossy: projected.unsupported > 0,
    };
  }
  return {
    content: markdownContent("", { profile }),
    diagnostics: [{ code: "MDFN_CONTENT_UNSUPPORTED", severity: "error", message: "Content value cannot be migrated to Markdown" }],
    lossy: true,
  };
}

export function mergeMigrationDiagnostics(content: MarkdownContent, diagnostics: readonly MdfnDiagnostic[]): MarkdownContent {
  if (diagnostics.some((entry) => entry.severity === "error")) throw new Error("MDFN_CONTENT_PROFILE_VALIDATION_FAILED");
  return content;
}

export const MDFN_CONTENTFN_VERSION = "0.1.0" as const;
