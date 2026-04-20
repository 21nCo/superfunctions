const INSTABILITY_PATTERNS = [
  /\bhmr update\b/i,
  /\bhmr invalidate\b/i,
  /\bpage reload\b/i,
  /\brestarting\b/i,
  /\brestart\b/i,
  /\bhot update\b/i,
] as const;

export interface DevServerSinkEvent {
  ts: string;
  source: 'dev-server';
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface InstabilitySignal {
  unstable: boolean;
  reason?: string;
}

export interface LineProcessor {
  push(chunk: Buffer | string): Promise<void>;
  flush(): Promise<void>;
}

export function createLineProcessor(
  stream: 'stdout' | 'stderr',
  onLine: (line: string, stream: 'stdout' | 'stderr') => Promise<void> | void,
): LineProcessor {
  let buffer = '';

  return {
    async push(chunk: Buffer | string): Promise<void> {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.length > 0) {
          await onLine(line, stream);
        }
      }
    },
    async flush(): Promise<void> {
      if (buffer.length > 0) {
        await onLine(buffer, stream);
        buffer = '';
      }
    },
  };
}

export function toDevServerSinkEvent(
  ts: string,
  stream: 'stdout' | 'stderr',
  line: string,
): DevServerSinkEvent {
  return {
    ts,
    source: 'dev-server',
    stream,
    line,
  };
}

export function detectInstability(line: string): InstabilitySignal {
  const matchedPattern = INSTABILITY_PATTERNS.find((pattern) => pattern.test(line));

  if (!matchedPattern) {
    return {
      unstable: false,
    };
  }

  return {
    unstable: true,
    reason: line,
  };
}
