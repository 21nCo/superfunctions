export interface NumberWidgetProps {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  required?: boolean;
  disabled?: boolean;
  "data-field-path"?: string;
}

export function NumberWidget({ value, onChange, required, disabled, "data-field-path": path }: NumberWidgetProps) {
  return (
    <input
      type="number"
      data-widget="number"
      data-field-path={path}
      data-required={required ?? undefined}
      value={value ?? ""}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === "" ? undefined : Number(v));
      }}
      disabled={disabled}
    />
  );
}
