/**
 * Map ContentFn field type to widget deterministically.
 * Custom widgets registered via registerWidget() override defaults (PLUG-001).
 */

import type { ContentfnField, ContentfnFieldType } from "@contentfn/core";
import { getWidgetForField } from "../plugins/registerWidget.js";
import {
  StringWidget,
  NumberWidget,
  BooleanWidget,
  DateWidget,
  JsonWidget,
  ObjectWidget,
  ArrayWidget,
  RichtextWidget,
  ReferenceWidget,
  ReferenceField,
  AssetWidget,
} from "./widgets/index.js";

type ReactNode = import("react").ReactNode;

export interface RenderFieldOptions {
  onOpenMediaPicker?: (fieldName: string) => void;
  /** Required for reference picker (ReferenceField). */
  baseUrl?: string;
  dataset?: string;
  /** When false, reference picker shows "no access" (TV-REF-PICKER-002). */
  hasDocReadForReference?: boolean;
  /** Document type name for custom widget resolution (typeName + fieldName). */
  docTypeName?: string;
}

export function renderField(
  field: ContentfnField,
  path: string,
  value: unknown,
  onChange: (value: unknown) => void,
  errorPath?: string | null,
  options?: RenderFieldOptions
): ReactNode {
  const required = field.required ?? false;
  const type = field.type;
  const fieldTypeKind = type.kind;
  const docTypeName = options?.docTypeName ?? "";
  const CustomWidget = docTypeName ? getWidgetForField(docTypeName, field.name, fieldTypeKind) : null;
  if (CustomWidget) {
    return (
      <CustomWidget
        data-field-path={path}
        value={value}
        onChange={onChange}
        required={required}
        disabled={false}
      />
    );
  }

  switch (type.kind) {
    case "primitive": {
      const t = type.type;
      if (t === "string" || t === "text") {
        return (
          <StringWidget
            data-field-path={path}
            value={value as string}
            onChange={(v) => onChange(v)}
            required={required}
            disabled={false}
          />
        );
      }
      if (t === "number") {
        return (
          <NumberWidget
            data-field-path={path}
            value={value as number | undefined}
            onChange={(v) => onChange(v)}
            required={required}
            disabled={false}
          />
        );
      }
      if (t === "boolean") {
        return (
          <BooleanWidget
            data-field-path={path}
            value={value as boolean | undefined}
            onChange={(v) => onChange(v)}
            required={required}
            disabled={false}
          />
        );
      }
      if (t === "date") {
        return (
          <DateWidget
            data-field-path={path}
            value={value as string | undefined}
            onChange={(v) => onChange(v)}
            required={required}
            dateOnly
            disabled={false}
          />
        );
      }
      if (t === "datetime") {
        return (
          <DateWidget
            data-field-path={path}
            value={value as string | undefined}
            onChange={(v) => onChange(v)}
            required={required}
            disabled={false}
          />
        );
      }
      if (t === "json") {
        return (
          <JsonWidget
            data-field-path={path}
            value={value}
            onChange={(v) => onChange(v)}
            required={required}
            disabled={false}
          />
        );
      }
      return <StringWidget data-field-path={path} value={String(value ?? "")} onChange={(v) => onChange(v)} required={required} disabled={false} />;
    }
    case "object":
      return (
        <ObjectWidget data-field-path={path} required={required}>
          {type.fields.map((f) => {
            const subPath = path ? `${path}.${f.name}` : f.name;
            const subVal = value && typeof value === "object" && value !== null && f.name in (value as object) ? (value as Record<string, unknown>)[f.name] : undefined;
            return (
              <label key={f.name}>
                {f.name}
                {renderField(f, subPath, subVal, (v) => {
                  const next = typeof value === "object" && value !== null ? { ...(value as object), [f.name]: v } : { [f.name]: v };
                  onChange(next);
                }, errorPath)}
              </label>
            );
          })}
        </ObjectWidget>
      );
    case "array":
      return (
        <ArrayWidget data-field-path={path} required={required}>
          {Array.isArray(value) ? (value as unknown[]).map((item, i) => (
            <div key={i}>
              <input
                data-widget="array-item"
                value={typeof item === "object" && item !== null && "text" in (item as object) ? (item as { text: string }).text : String(item)}
                onChange={(e) => {
                  const arr = [...(value as unknown[])];
                  arr[i] = e.target.value;
                  onChange(arr);
                }}
              />
            </div>
          )) : null}
          <button type="button" onClick={() => onChange(Array.isArray(value) ? [...(value as unknown[]), ""] : [""])}>
            Add item
          </button>
        </ArrayWidget>
      );
    case "richtext":
      return (
        <RichtextWidget
          data-field-path={path}
          value={value}
          onChange={(v) => onChange(v)}
          required={required}
          disabled={false}
        />
      );
    case "reference": {
      const allowedTypes = type.to ?? [];
      if (options?.baseUrl != null && options?.dataset != null) {
        return (
          <ReferenceField
            data-field-path={path}
            value={value}
            onChange={(v) => onChange(v)}
            required={required}
            disabled={false}
            baseUrl={options.baseUrl}
            dataset={options.dataset}
            allowedTypes={allowedTypes}
            hasDocRead={options.hasDocReadForReference ?? true}
          />
        );
      }
      return (
        <ReferenceWidget
          data-field-path={path}
          value={value}
          onChange={(v) => onChange(v)}
          required={required}
          disabled={false}
        />
      );
    }
    case "asset":
      return (
        <AssetWidget
          data-field-path={path}
          value={value}
          onChange={(v) => onChange(v)}
          required={required}
          disabled={false}
          onOpenMediaPicker={options?.onOpenMediaPicker ? () => options!.onOpenMediaPicker!(path) : undefined}
        />
      );
    default:
      return <span data-widget="unknown">Unknown field type</span>;
  }
}
