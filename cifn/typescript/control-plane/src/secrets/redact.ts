/** Mask literal values before log publication, including separately emitted multiline components. */
export function redactSecrets(lines: string[], secretValues: string[]): string[] {
  const literals = [...new Set(secretValues.flatMap(value => [value, ...value.split(/\r\n|\r|\n/)]))]
    .filter(value => value.length > 0)
    .sort((left, right) => right.length - left.length);
  if (literals.length === 0) return lines;
  // Match original text once: shorter overlapping values must not expose a suffix,
  // and values containing '*' must not repeatedly transform inserted markers.
  const pattern = new RegExp(literals.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return lines.map(line => line.replace(pattern, () => '***'));
}
