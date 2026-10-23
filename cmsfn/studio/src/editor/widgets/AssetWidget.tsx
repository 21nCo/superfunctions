export interface AssetWidgetProps {
  value: unknown;
  onChange: (value: unknown) => void;
  required?: boolean;
  disabled?: boolean;
  "data-field-path"?: string;
  /** When set, show "Select from library" to open media picker. */
  onOpenMediaPicker?: () => void;
}

/** Canonical shape { _type: "asset", _ref: string, assetType: "image"|"file" }. */
export function AssetWidget({ value, onChange, required, "data-field-path": path, onOpenMediaPicker }: AssetWidgetProps) {
  const ref = value && typeof value === "object" && "_ref" in (value as object) ? (value as { _ref: string })._ref : "";
  return (
    <div data-widget="asset" data-field-path={path} data-required={required ?? undefined}>
      <input
        type="text"
        placeholder="Asset ref"
        value={ref}
        onChange={(e) =>
          onChange(e.target.value ? { _type: "asset", _ref: e.target.value, assetType: "file" as const } : undefined)
        }
        disabled={false}
      />
      {onOpenMediaPicker && (
        <button type="button" data-asset-open-media onClick={onOpenMediaPicker}>
          Select from library
        </button>
      )}
    </div>
  );
}
