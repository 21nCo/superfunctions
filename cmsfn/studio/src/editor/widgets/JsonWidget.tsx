export interface JsonWidgetProps {
  value: unknown;
  onChange: (value: unknown) => void;
  required?: boolean;
  disabled?: boolean;
  "data-field-path"?: string;
}

export function JsonWidget({ value, onChange, required, disabled, "data-field-path": path }: JsonWidgetProps) {
  const str = typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2);
  return (
    <textarea
      data-widget="json"
      data-field-path={path}
      data-required={required ?? undefined}
      value={str}
      onChange={(e) => {
        try {
          onChange(JSON.parse(e.target.value || "null"));
        } catch {
          onChange(e.target.value);
        }
      }}
      disabled={disabled}
      rows={4}
    />
  );
}
