/**
 * Reference field: display current ref, open picker to select → write canonical { _type: "reference", _ref }.
 */

import { useState, useRef } from "react";
import { ReferencePickerDialog } from "./ReferencePickerDialog.js";

export interface ReferenceFieldProps {
  value: unknown;
  onChange: (value: unknown) => void;
  required?: boolean;
  disabled?: boolean;
  "data-field-path"?: string;
  baseUrl: string;
  cmsfnApiUrl?: string;
  allowContentfnAuthorization?: boolean;
  ownerScope?: string;
  dataset: string;
  /** Allowed document types (reference field's `to`). */
  allowedTypes: string[];
  /** When false, picker shows "no access" (TV-REF-PICKER-002). */
  hasDocRead?: boolean;
}

const canonicalRef = (v: unknown): { _type: "reference"; _ref: string } | undefined => {
  if (v && typeof v === "object" && "_ref" in (v as object)) {
    const ref = (v as { _ref: string })._ref;
    if (typeof ref === "string") return { _type: "reference", _ref: ref };
  }
  return undefined;
};

export function ReferenceField({
  value,
  onChange,
  required,
  disabled,
  "data-field-path": path,
  baseUrl, cmsfnApiUrl, allowContentfnAuthorization = false, ownerScope,
  dataset,
  allowedTypes,
  hasDocRead = true,
}: ReferenceFieldProps) {
  const ref = canonicalRef(value);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const closePicker = () => { setPickerScope(null); buttonRef.current?.focus(); };
  const scope = JSON.stringify([baseUrl, cmsfnApiUrl, dataset, path, [...allowedTypes].sort(), allowContentfnAuthorization, ownerScope, disabled, hasDocRead]);
  const current = useRef(scope); current.current = scope;
  const [pickerScope, setPickerScope] = useState<string | null>(null);

  return (
    <div data-widget="reference-field" data-field-path={path} data-required={required ?? undefined}>
      <div data-reference-display>{ref ? ref._ref : "Unset"}</div>
      <button
        aria-label="Choose reference"
        ref={buttonRef}
        type="button"
        onClick={() => setPickerScope(scope)}
        disabled={disabled}
        data-reference-open-picker
      >
        Choose reference
      </button>
      {pickerScope === scope && !disabled && (
        <ReferencePickerDialog
          baseUrl={baseUrl}
          cmsfnApiUrl={cmsfnApiUrl}
          allowContentfnAuthorization={allowContentfnAuthorization}
          dataset={dataset}
          allowedTypes={allowedTypes}
          hasDocRead={hasDocRead}
          onSelect={(r) => {
            if (current.current !== scope) return;
            onChange(r);
            closePicker();
          }}
          onClose={closePicker}
        />
      )}
    </div>
  );
}
