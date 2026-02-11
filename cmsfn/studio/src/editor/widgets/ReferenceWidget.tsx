export interface ReferenceWidgetProps {
  value: unknown;
  onChange: (value: unknown) => void;
  required?: boolean;
  disabled?: boolean;
  "data-field-path"?: string;
}

/** Placeholder: full picker in PHASE_09. Canonical shape { _type: "reference", _ref: string }. */
export function ReferenceWidget({ value, onChange, required, "data-field-path": path }: ReferenceWidgetProps) {
  const ref = value && typeof value === "object" && "_ref" in (value as object) ? (value as { _ref: string })._ref : "";
  return (
    <div data-widget="reference" data-field-path={path} data-required={required ?? undefined}>
      <input
        type="text"
        placeholder="Reference ID (placeholder)"
        value={ref}
        onChange={(e) => onChange(e.target.value ? { _type: "reference", _ref: e.target.value } : undefined)}
        disabled={false}
      />
    </div>
  );
}
