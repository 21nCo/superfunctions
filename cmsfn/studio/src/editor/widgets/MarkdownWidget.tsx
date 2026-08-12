import { useEffect, useMemo } from "react";
import { Transaction } from "@mdfn/core";
import { createMdfn } from "mdfn";
import { MdfnEditorShell } from "@mdfn/components-react";

export interface MarkdownWidgetProps {
  value: unknown;
  onChange: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  "data-field-path"?: string;
}

export function MarkdownWidget({ value, onChange, required, disabled, "data-field-path": path }: MarkdownWidgetProps) {
  const controller = useMemo(() => createMdfn({ markdown: typeof value === "string" ? value : "" }), [path]);
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
    <div data-widget="markdown" data-field-path={path} data-required={required ?? undefined}>
      <MdfnEditorShell controller={controller} mode={disabled ? "read-only" : "visual"} readOnly={disabled} ariaLabel={path ? `${path} Markdown editor` : "Markdown editor"} />
    </div>
  );
}
