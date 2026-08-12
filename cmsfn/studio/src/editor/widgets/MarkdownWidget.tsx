import { useEffect, useMemo } from "react";
import { Transaction } from "@mdfn/core";
import { createMdfn } from "mdfn";
import { MdfnEditorShell } from "@mdfn/components-react";
import { calloutExtension, commonmarkExtension, diagramExtension, gfmExtension } from "@mdfn/extensions";

export interface MarkdownWidgetProps {
  value: unknown;
  onChange: (value: string) => void;
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
  const extensionKey = extensions.join("\u0000");
  const controller = useMemo(() => {
    const resolved = [commonmarkExtension, ...(dialect === "gfm" ? [gfmExtension] : []), ...resolveConfiguredExtensions(extensions)];
    return createMdfn({ markdown: typeof value === "string" ? value : "", markdownOptions: { dialect, allowRawHtml, schemaVersion, extensions: resolved } });
  }, [path, dialect, allowRawHtml, schemaVersion, extensionKey]);
  useEffect(() => {
    const next = typeof value === "string" ? value : "";
    const current = controller.getState().markdown;
    if (next !== current) controller.dispatch(new Transaction().replaceSource(0, current.length, next).withSource("cmsfn:external"));
  }, [controller, value]);
  useEffect(() => controller.subscribe((change) => {
    if (change.documentChanged && change.source !== "cmsfn:external") onChange(change.current.markdown);
  }), [controller, onChange]);
  useEffect(() => () => controller.destroy(), [controller]);
  return (
    <div data-widget="markdown" data-field-path={path} data-required={required ?? undefined} data-markdown-dialect={dialect} data-raw-html={String(allowRawHtml)} data-schema-version={schemaVersion} data-extensions={extensions.join(",")}>
      <MdfnEditorShell controller={controller} mode={disabled ? "read-only" : "visual"} readOnly={disabled} ariaLabel={path ? `${path} Markdown editor` : "Markdown editor"} />
    </div>
  );
}
