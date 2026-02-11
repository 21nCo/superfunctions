export interface DateWidgetProps {
  value: string | undefined;
  onChange: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  dateOnly?: boolean;
  "data-field-path"?: string;
}

export function DateWidget({ value, onChange, required, disabled, dateOnly, "data-field-path": path }: DateWidgetProps) {
  const type = dateOnly ? "date" : "datetime-local";
  return (
    <input
      type={type}
      data-widget="date"
      data-field-path={path}
      data-required={required ?? undefined}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
    />
  );
}
