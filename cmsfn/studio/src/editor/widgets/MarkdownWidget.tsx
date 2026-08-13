import { useEffect, useMemo } from "react";
import { Transaction } from "@mdfn/core";
import { createMdfn } from "mdfn";
import { MdfnEditorShell } from "@mdfn/components-react";
import { calloutExtension, commonmarkExtension, diagramExtension, gfmExtension } from "@mdfn/extensions";
import { isMarkdownContent, markdownContent, type MarkdownContent, type MarkdownContentProfile } from "@mdfn/contentfn";

export interface MarkdownWidgetProps {
  value: unknown;
  onChange: (value: MarkdownContent) => void;
  required?: boolean;
  disabled?: boolean;
  dialect?: "commonmark" | "gfm";
  allowRawHtml?: boolean;
  extensions?: readonly string[];
  schemaVersion?: number;
  "data-field-path"?: string;
}

const extensionByName = { callout: calloutExtension, "directive/callout": calloutExtension, diagram: diagramExtension, "directive/diagram": diagramExtension } as const;

function resolveConfiguredExtensions(names: readonly string[]) {
  return names.map((name) => {
    const extension = extensionByName[name as keyof typeof extensionByName];
    if (!extension) throw new Error(`MDFN_EXTENSION_UNKNOWN:${name}`);
    return extension;
  });
}

export function MarkdownWidget({ value, onChange, required, disabled, dialect = "gfm", allowRawHtml = false, extensions = [], schemaVersion = 1, "data-field-path": path }: MarkdownWidgetProps) {
  const fallbackProfile: MarkdownContentProfile = { id: `mdfn:${dialect}`, dialect, allowRawHtml, extensions, schemaVersion };
  const content = isMarkdownContent(value) ? value : markdownContent(typeof value === "string" ? value : "", { profile: fallbackProfile });
  const activeProfile = content.profile;
  const extensionKey = activeProfile.extensions.join("\u0000");
  const sidecarKey = JSON.stringify(content.sidecar ?? null);
  const controller = useMemo(() => {
    const resolved = [commonmarkExtension, ...(activeProfile.dialect === "gfm" ? [gfmExtension] : []), ...resolveConfiguredExtensions(activeProfile.extensions)];
    return createMdfn({ markdown: content.markdown, sidecar: content.sidecar, markdownOptions: { dialect: activeProfile.dialect, allowRawHtml: activeProfile.allowRawHtml, schemaVersion: activeProfile.schemaVersion, extensions: resolved } });
  }, [path, activeProfile.id, activeProfile.dialect, activeProfile.allowRawHtml, activeProfile.schemaVersion, extensionKey]);
  useEffect(() => {
    const next = content.markdown;
    const current = controller.getState();
    let transaction = new Transaction().withSource("cmsfn:external").withMetadata({ addToHistory: false });
    if (next !== current.markdown) transaction = transaction.replaceSource(0, current.markdown.length, next);
    if (sidecarKey !== JSON.stringify(current.sidecar ?? null)) transaction = transaction.setSidecar(content.sidecar);
    if (transaction.operations.length > 0) controller.dispatch(transaction);
  }, [controller, content.markdown, sidecarKey]);
  useEffect(() => controller.subscribe((change) => {
    if ((change.documentChanged || change.sidecarChanged) && change.source !== "cmsfn:external") onChange(markdownContent(change.current.markdown, { profile: activeProfile, schemaHash: change.current.schemaHash, sidecar: change.current.sidecar }));
  }), [controller, onChange, activeProfile]);
  useEffect(() => () => controller.destroy(), [controller]);
  return (
    <div data-widget="markdown" data-field-path={path} data-required={required ?? undefined} data-markdown-dialect={activeProfile.dialect} data-raw-html={String(activeProfile.allowRawHtml)} data-schema-version={activeProfile.schemaVersion} data-extensions={activeProfile.extensions.join(",")}>
      <MdfnEditorShell controller={controller} mode={disabled ? "read-only" : "visual"} readOnly={disabled} ariaLabel={path ? `${path} Markdown editor` : "Markdown editor"} />
    </div>
  );
}
