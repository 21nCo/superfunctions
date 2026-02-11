export interface RichtextWidgetProps {
  value: unknown;
  onChange: (value: unknown) => void;
  required?: boolean;
  disabled?: boolean;
  "data-field-path"?: string;
}

/**
 * Basic richtext: block array placeholder. Full block editor in later phases.
 */
export function RichtextWidget({ value, onChange, required, disabled, "data-field-path": path }: RichtextWidgetProps) {
  const blocks = Array.isArray(value) ? value : [];
  const text = blocks
    .map((b: unknown) => (typeof b === "object" && b !== null && "children" in (b as object)) ? (b as { children?: unknown[] }).children?.map((c: unknown) => (c as { text?: string })?.text ?? "").join("") : String(b))
    .join("\n");
  return (
    <textarea
      data-widget="richtext"
      data-field-path={path}
      data-required={required ?? undefined}
      value={text}
      onChange={(e) => {
        const line = e.target.value;
        onChange(line ? [{ _type: "block", children: [{ _type: "span", text: line }] }] : []);
      }}
      disabled={disabled}
      rows={6}
    />
  );
}
