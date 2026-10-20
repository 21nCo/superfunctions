/** JSON structural equality: objects ignore key order; bool, number and string stay distinct. */
export function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('Flag values must be finite, acyclic JSON values');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Flag values must use plain JSON objects');
  const keys = Object.keys(value);
  if (Reflect.ownKeys(value).length !== keys.length + (Array.isArray(value) ? 1 : 0) || keys.some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return descriptor.get !== undefined || descriptor.set !== undefined;
  })) throw new TypeError('Flag values must use enumerable JSON data properties');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (keys.length !== value.length) throw new TypeError('Flag arrays must not contain holes or extra properties');
      for (let index = 0; index < value.length; index++) if (!Object.prototype.hasOwnProperty.call(value, String(index))) throw new TypeError('Flag arrays must not contain holes');
      return '[' + value.map(item => canonicalJson(item, ancestors)).join(',') + ']';
    }
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key], ancestors)).join(',') + '}';
  } finally { ancestors.delete(value); }
}

/** Throws for non-JSON operands so negative operators cannot grant invalid values. */
export function jsonEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
