import type { AdminJsonSchema } from '@superfunctions/admin';
import type { AdminActionViewModel } from './view-models';

export type ActionFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
export type ActionDraftValue = string | boolean | undefined;
export type ActionDraft = Record<string, ActionDraftValue>;

export interface ActionInputField {
  name: string;
  label: string;
  description?: string;
  type: ActionFieldType;
  required: boolean;
  schema: AdminJsonSchema;
}

export type ActionInputResult =
  | { ok: true; input: Record<string, unknown>; errors: Record<string, never> }
  | { ok: false; input: Record<string, unknown>; errors: Record<string, string> };

function fieldLabel(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/^./, (character) => character.toUpperCase());
}

function fieldType(schema: AdminJsonSchema): ActionFieldType {
  const declared = Array.isArray(schema.type)
    ? schema.type.find((type) => type !== 'null')
    : schema.type;
  return ['number', 'integer', 'boolean', 'object', 'array'].includes(declared ?? '')
    ? declared as ActionFieldType
    : 'string';
}

export function editableActionFields(action: AdminActionViewModel): ActionInputField[] {
  const schema = action.inputSchema;
  if (!schema?.properties) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).flatMap(([name, property]) => {
    if (name === action.targetIdInput) return [];
    return [{
      name,
      label: property.title ?? fieldLabel(name),
      description: property.description,
      type: fieldType(property),
      required: required.has(name),
      schema: property,
    }];
  });
}

function initialValue(field: ActionInputField, value: unknown): ActionDraftValue {
  const candidate = value ?? field.schema.default;
  if (field.type === 'boolean') {
    return typeof candidate === 'boolean' ? candidate : field.required ? false : undefined;
  }
  if (candidate === undefined || candidate === null) return '';
  if (field.type === 'object' || field.type === 'array') {
    return JSON.stringify(candidate, null, 2);
  }
  return String(candidate);
}

export function createActionDraft(action: AdminActionViewModel): ActionDraft {
  return Object.fromEntries(
    editableActionFields(action).map((field) => [
      field.name,
      initialValue(field, action.input?.[field.name]),
    ])
  );
}

function parseField(field: ActionInputField, raw: ActionDraftValue): { value?: unknown; error?: string; omit?: boolean } {
  if (field.type === 'boolean') {
    if (raw === undefined) {
      return field.required
        ? { error: `${field.label} is required.` }
        : { omit: true };
    }
    return { value: raw === true };
  }

  const text = typeof raw === 'string' ? raw : '';
  if (!text.trim()) {
    return field.required
      ? { error: `${field.label} is required.` }
      : { omit: true };
  }

  if (field.type === 'number' || field.type === 'integer') {
    const value = Number(text);
    if (!Number.isFinite(value) || (field.type === 'integer' && !Number.isInteger(value))) {
      return { error: `${field.label} must be a valid ${field.type}.` };
    }
    if (typeof field.schema.minimum === 'number' && value < field.schema.minimum) {
      return { error: `${field.label} must be at least ${field.schema.minimum}.` };
    }
    if (typeof field.schema.maximum === 'number' && value > field.schema.maximum) {
      return { error: `${field.label} must be at most ${field.schema.maximum}.` };
    }
    return { value };
  }

  if (field.type === 'object' || field.type === 'array') {
    try {
      const value: unknown = JSON.parse(text);
      if (field.type === 'array' ? !Array.isArray(value) : typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { error: `${field.label} must be a JSON ${field.type}.` };
      }
      return { value };
    } catch {
      return { error: `${field.label} must contain valid JSON.` };
    }
  }

  if (typeof field.schema.minLength === 'number' && text.length < field.schema.minLength) {
    return { error: `${field.label} must contain at least ${field.schema.minLength} characters.` };
  }
  if (typeof field.schema.maxLength === 'number' && text.length > field.schema.maxLength) {
    return { error: `${field.label} must contain at most ${field.schema.maxLength} characters.` };
  }
  if (Array.isArray(field.schema.enum) && !field.schema.enum.includes(text)) {
    return { error: `${field.label} must be one of the declared values.` };
  }
  return { value: text };
}

export function validateActionInput(action: AdminActionViewModel, draft: ActionDraft): ActionInputResult {
  const input = { ...(action.input ?? {}) };
  const errors: Record<string, string> = {};
  for (const field of editableActionFields(action)) {
    const parsed = parseField(field, draft[field.name]);
    if (parsed.error) {
      errors[field.name] = parsed.error;
      continue;
    }
    if (parsed.omit) delete input[field.name];
    else input[field.name] = parsed.value;
  }
  return Object.keys(errors).length
    ? { ok: false, input, errors }
    : { ok: true, input, errors: {} };
}
