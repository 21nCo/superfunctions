import { createHash } from 'node:crypto';
export const LOG_METADATA_LIMIT = 10000;
export function indexValue(value: unknown): { valueType: string; valueKey: string } | undefined {
  let valueType: string, bytes: Buffer;
  if (value === null) { valueType = 'null'; bytes = Buffer.alloc(0); }
  else if (typeof value === 'string') {
    // Reject lone UTF-16 surrogates instead of hashing replacement bytes. Python's
    // UTF-8 encoder follows the same strict contract for persisted scalar keys.
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('Invalid Unicode log index value'); }
      else if (unit >= 0xdc00 && unit <= 0xdfff) throw new TypeError('Invalid Unicode log index value');
    }
    valueType = 'string'; bytes = Buffer.from(value, 'utf8');
  }
  else if (typeof value === 'boolean') { valueType = 'boolean'; bytes = Buffer.from(value ? '1' : '0'); }
  else if (typeof value === 'number' && Number.isFinite(value)) {
    valueType = 'number'; bytes = Buffer.alloc(8); bytes.writeDoubleBE(Object.is(value, -0) ? 0 : value);
  } else return;
  return { valueType, valueKey: createHash('sha256').update(valueType + '\0').update(bytes).digest('hex') };
}
export function indexId(eventId: string, field: string): string { return createHash('sha256').update(eventId + '\0' + field).digest('hex'); }
export function logField(event: Record<string, any>, field: string): unknown {
  const parts = field.split('.');
  const read = (value: any): unknown => {
    for (const key of parts) {
      if (value == null || !Object.hasOwn(value, key)) return;
      value = value[key];
    }
    return value;
  };
  return Object.hasOwn(event, parts[0]) ? read(event) : read(event.properties);
}
export function equalitySeek(where: unknown): { field: string; valueType: string; valueKey: string } | undefined {
  if (!where || typeof where !== 'object' || Array.isArray(where) || (where as any).type !== 'log') return;
  for (const [field, condition] of Object.entries(where)) {
    if (field === 'type') continue;
    const value = condition && typeof condition === 'object' && !Array.isArray(condition)
      ? Object.keys(condition).length === 1 && Object.hasOwn(condition, 'eq') ? (condition as any).eq : undefined
      : condition;
    const scalar = indexValue(value);
    if (scalar) return { field, ...scalar };
  }
}

export function validateIndexFields(fields: readonly string[]): string[] {
  if (!Array.isArray(fields) || fields.length > 32 || fields.some(field => typeof field !== 'string' || field.length > 128 || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(field) || field.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part)))) throw new TypeError('Invalid log index fields');
  return [...new Set(fields)].sort();
}
