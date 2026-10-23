import * as yaml from 'js-yaml';

export type ParseFormat = 'yaml' | 'json' | 'auto';

const MAX_DOC_SIZE = 500 * 1024;

/**
 * Normalizes parsed pipeline raw so that `on.schedule` is always an array.
 * Accepts schedule as either `{ cron: string }` or `[{ cron: string }, ...]`;
 * canonical form is array. Mutates and returns the same object.
 */
export function normalizeParsedPipeline(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;
  const on = obj.on;
  if (!on || typeof on !== 'object') return raw;
  const onObj = on as Record<string, unknown>;
  const schedule = onObj.schedule;
  if (schedule === undefined) return raw;
  if (Array.isArray(schedule)) return raw;
  if (schedule && typeof schedule === 'object' && 'cron' in schedule) {
    onObj.schedule = [schedule];
  }
  return raw;
}

export function parse(input: string, format: ParseFormat = 'auto'): unknown {
  if (input.length > MAX_DOC_SIZE) {
    throw new Error(`Pipeline document size (${input.length} bytes) exceeds maximum size of 500KB`);
  }

  if (format === 'json') {
    return parseJson(input);
  }
  if (format === 'yaml') {
    return parseYaml(input);
  }

  // auto: try JSON first, then YAML
  try {
    return parseJson(input);
  } catch {
    return parseYaml(input);
  }
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch (err) {
    throw new Error(`Failed to parse JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function parseYaml(input: string): unknown {
  try {
    const result = yaml.load(input);
    if (result === undefined || result === null) {
      throw new Error('Empty YAML document');
    }
    return result;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Failed to parse') || err instanceof Error && err.message === 'Empty YAML document') {
      throw err;
    }
    throw new Error(`Failed to parse YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
}
