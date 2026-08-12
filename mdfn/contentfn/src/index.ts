import type { MdfnSidecar, MdfnSnapshot } from "@mdfn/core";

export interface MarkdownContent {
  readonly type: "text/markdown";
  readonly markdown: string;
  readonly schemaHash?: string;
  readonly sidecar?: MdfnSidecar;
}

export function markdownContent(markdown: string, options: Omit<MarkdownContent, "type" | "markdown"> = {}): MarkdownContent {
  return Object.freeze({ type: "text/markdown", markdown, ...options });
}

export function snapshotToContent(snapshot: MdfnSnapshot): MarkdownContent {
  return markdownContent(snapshot.markdown, { schemaHash: snapshot.schemaHash, sidecar: snapshot.sidecar });
}

export function isMarkdownContent(value: unknown): value is MarkdownContent {
  const candidate = value as Partial<MarkdownContent> | null;
  return candidate?.type === "text/markdown" && typeof candidate.markdown === "string";
}

export const MDFN_CONTENTFN_VERSION = "0.1.0" as const;
