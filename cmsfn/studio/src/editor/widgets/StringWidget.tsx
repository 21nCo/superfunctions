export interface StringWidgetProps {
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  "data-field-path"?: string;
}

export function StringWidget({ value, onChange, required, disabled, "data-field-path": path }: StringWidgetProps) {
  return (
    <input
      type="text"
      data-widget="string"
      data-field-path={path}
      data-required={required ?? undefined}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      required={required}
    />
  );
}
