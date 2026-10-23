import type { CanonicalAssetRef } from './insertAssetRef.js';
/** Schema field segments are literal keys, never parsed dotted paths or array indices. */
export function insertAssetAtPath(document: Record<string, unknown>, path: readonly string[], asset: CanonicalAssetRef): Record<string, unknown> {
  if (!path.length || path.length > 128 || path.some(key => !key || ['__proto__', 'prototype', 'constructor'].includes(key))) throw Error('Invalid asset field path');
  const replace = (value: unknown, index: number): Record<string, unknown> => {
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw Error('Asset field parent must be an object');
    const record = value as Record<string, unknown> | undefined;
    const key = path[index];
    const previous = record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
    return { ...record, [key]: index === path.length - 1 ? asset : replace(previous, index + 1) };
  };
  return replace(document, 0);
}
