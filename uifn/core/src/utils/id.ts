let count = 0;

export function generateId(prefix = 'uifn'): string {
  return `${prefix}-${++count}`;
}
