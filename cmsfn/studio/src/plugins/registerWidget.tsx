/**
 * Register custom field widgets. Deterministic resolution: last registration wins (TV-PLUG-002).
 */

import type { WidgetSelector } from "cmsfn";
import { createWidgetRegistry } from "cmsfn";
import type { ReactNode } from "react";

export interface CustomWidgetProps {
  "data-field-path"?: string;
  value: unknown;
  onChange: (value: unknown) => void;
  required?: boolean;
  disabled?: boolean;
}

export type CustomWidgetComponent = (props: CustomWidgetProps) => ReactNode;

const registry = createWidgetRegistry();
let idCounter = 0;
const componentById = new Map<string, CustomWidgetComponent>();

/**
 * Register a custom widget for a field.
 * Selector: { typeName, fieldName } for a specific field, or { fieldType } for all fields of that type.
 * Last registration for the same selector wins (TV-PLUG-002).
 */
export function registerWidget(
  selector: WidgetSelector,
  component: CustomWidgetComponent
): void {
  // Registration is explicit application code, never evaluated from serialized config.
  // Validate before touching either registry so a rejected call cannot shadow a widget.
  let snapshot: WidgetSelector;
  try {
    if (typeof component !== "function" || !selector || typeof selector !== "object" || Array.isArray(selector)) throw new Error();
    const prototype = Object.getPrototypeOf(selector);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(selector);
    const keys = Reflect.ownKeys(descriptors);
    if (!keys.length || keys.some(key => key !== "typeName" && key !== "fieldName" && key !== "fieldType")) throw new Error();
    snapshot = {};
    for (const key of keys) {
      if (key !== "typeName" && key !== "fieldName" && key !== "fieldType") throw new Error();
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) throw new Error();
      if (descriptor.value === undefined) continue;
      if (typeof descriptor.value !== "string" || !descriptor.value.length) throw new Error();
      snapshot[key] = descriptor.value;
    }
    if (!Object.keys(snapshot).length) throw new Error();
  } catch { throw new TypeError("Invalid widget registration"); }
  const id = `widget-${++idCounter}`;
  registry.register(snapshot, id);
  componentById.set(id, component);
}

/**
 * Get the custom widget component for (typeName, fieldName, fieldType), if any.
 * Used by renderField to override default widgets.
 */
export function getWidgetForField(
  typeName: string,
  fieldName: string,
  fieldType: string
): CustomWidgetComponent | null {
  const id = registry.getWidgetId(typeName, fieldName, fieldType);
  if (id == null) return null;
  return componentById.get(id) ?? null;
}
