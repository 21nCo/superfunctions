export interface BooleanWidgetProps {
  value: boolean | undefined;
  onChange: (value: boolean) => void;
  required?: boolean;
  disabled?: boolean;
  "data-field-path"?: string;
}

export function BooleanWidget({ value, onChange, required, disabled, "data-field-path": path }: BooleanWidgetProps) {
  return (
    <input
      type="checkbox"
      data-widget="boolean"
      data-field-path={path}
      data-required={required ?? undefined}
      checked={value ?? false}
      onChange={(e) => onChange(e.target.checked)}
      disabled={disabled}
    />
  );
}
