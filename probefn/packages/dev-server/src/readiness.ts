import { createProbefnError } from '@probefn/contracts/errors';

const DEFAULT_READY_PATTERNS = [
  /Local:\s+(https?:\/\/[^\s]+)/i,
  /ready in\s+\d+/i,
] as const;

export interface ReadinessMatch {
  ready: boolean;
  matchedPattern?: string;
  resolvedUrl?: string;
}

export function compileReadyPattern(pattern?: string): RegExp[] {
  if (!pattern) {
    return [...DEFAULT_READY_PATTERNS];
  }

  try {
    return [new RegExp(pattern, 'i')];
  } catch (error) {
    throw createProbefnError({
      code: 'E_CONFIG_INVALID',
      message: `Invalid readyPattern ${pattern}.`,
      retryable: false,
      details: {
        readyPattern: pattern,
      },
      cause: error,
    });
  }
}

export function detectReadiness(line: string, patterns: RegExp[]): ReadinessMatch {
  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (!match) {
      continue;
    }

    return {
      ready: true,
      matchedPattern: pattern.source,
      ...(extractUrl(line) ?? match[1] ? { resolvedUrl: extractUrl(line) ?? match[1] } : {}),
    };
  }

  return {
    ready: false,
  };
}

function extractUrl(line: string): string | undefined {
  const match = line.match(/https?:\/\/[^\s]+/i);
  return match?.[0];
}
