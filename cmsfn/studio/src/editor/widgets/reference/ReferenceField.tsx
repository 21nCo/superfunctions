/**
 * Reference field: display current ref, open picker to select → write canonical { _type: "reference", _ref }.
 */

import { useState } from "react";
import { ReferencePickerDialog } from "./ReferencePickerDialog.js";

export interface ReferenceFieldProps {
  value: unknown;
  onChange: (value: unknown) => void;
  required?: boolean;
  disabled?: boolean;
  "data-field-path"?: string;
  baseUrl: string;
  dataset: string;
  /** Allowed document types (reference field's `to`). */
  allowedTypes: string[];
  /** When false, picker shows "no access" (TV-REF-PICKER-002). */
  hasDocRead?: boolean;
}

const canonicalRef = (v: unknown): { _type: "reference"; _ref: string } | undefined => {
  if (v && typeof v === "object" && "_ref" in (v as object)) {
    const ref = (v as { _ref: string })._ref;
    if (typeof ref === "string") return { _type: "reference", _ref };
  }
  return undefined;
};

export function ReferenceField({
  value,
  onChange,
  required,
  disabled,
  "data-field-path": path,
  baseUrl,
  dataset,
  allowedTypes,
  hasDocRead = true,
}: ReferenceFieldProps) {
  const ref = canonicalRef(value);
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div data-widget="reference-field" data-field-path={path} data-required={required ?? undefined}>
      <div data-reference-display>{ref ? ref._ref : "Unset"}</div>
      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        disabled={disabled}
        data-reference-open-picker
      >
        Choose reference
      </button>
      {pickerOpen && (
        <ReferencePickerDialog
          baseUrl={baseUrl}
          dataset={dataset}
          allowedTypes={allowedTypes}
          hasDocRead={hasDocRead}
          onSelect={(r) => {
            onChange(r);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
