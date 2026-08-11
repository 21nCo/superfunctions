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
  const id = `widget-${++idCounter}`;
  registry.register(selector, id);
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
