const REDACTED_PLACEHOLDER = '[REDACTED]';
const OMIT = Symbol('probefn.export-filter.omit');

export interface ExportFilterOptions {
  includeAuthProfiles?: boolean;
}

export interface ExportFilterResult<TValue> {
  value: TValue;
  omittedAuthProfilePaths: number;
  omittedPaths: string[];
}

export function filterSensitiveExportData<TValue>(
  input: TValue,
  options: ExportFilterOptions = {},
): ExportFilterResult<TValue> {
  if (options.includeAuthProfiles) {
    return {
      value: input,
      omittedAuthProfilePaths: 0,
      omittedPaths: [],
    };
  }

  const omittedPaths: string[] = [];
  let omittedAuthProfilePaths = 0;

  const walk = (value: unknown, currentPath: string): unknown => {
    if (typeof value === 'string') {
      if (isAuthProfileArtifactPath(value)) {
        omittedAuthProfilePaths += 1;
        omittedPaths.push(currentPath || '$');
        return OMIT;
      }

      return value;
    }

    if (value === null || typeof value !== 'object') {
      return value;
    }

    if (Array.isArray(value)) {
      return value
        .map((entry, index) => walk(entry, `${currentPath}[${index}]`))
        .filter((entry) => entry !== OMIT);
    }

    const next: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      const walked = walk(nestedValue, currentPath ? `${currentPath}.${key}` : key);
      if (walked !== OMIT) {
        next[key] = walked;
      }
    }
    return next;
  };

  return {
    value: walk(input, '') as TValue,
    omittedAuthProfilePaths,
    omittedPaths,
  };
}

export function countRedactedPlaceholders(input: unknown): number {
  if (typeof input === 'string') {
    return input.match(/\[REDACTED\]/g)?.length ?? 0;
  }

  if (input === null || typeof input !== 'object') {
    return 0;
  }

  if (Array.isArray(input)) {
    return input.reduce((count, value) => count + countRedactedPlaceholders(value), 0);
  }

  return Object.values(input).reduce(
    (count, value) => count + countRedactedPlaceholders(value),
    0,
  );
}

export function isAuthProfileArtifactPath(value: string): boolean {
  return /(^|\/)auth-profiles\/[^/]+\/storage-state\.json$/i.test(
    value.replace(/\\/g, '/'),
  );
}

export { REDACTED_PLACEHOLDER };
