export function redactSecrets(lines: string[], secretValues: string[]): string[] {
  if (secretValues.length === 0) return lines;
  return lines.map(line => {
    let result = line;
    for (const secret of secretValues) {
      if (secret.length > 0) {
        result = result.split(secret).join('***');
      }
    }
    return result;
  });
}
