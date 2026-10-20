import { readEventSinkFamily } from '@probefn/storage';

export interface EventDeltaBaseline {
  consoleErrors: number;
  pageErrors: number;
  networkFailures: number;
}

export interface EventDeltaSummary {
  newConsoleErrors: number;
  newPageErrors: number;
  newNetworkFailures: number;
}

export interface EventDeltaPaths {
  consoleSinkPath?: string;
  pageErrorSinkPath?: string;
  networkSinkPath?: string;
}

export async function captureEventDeltaBaseline(
  repoRoot: string,
  paths: EventDeltaPaths,
): Promise<EventDeltaBaseline> {
  return {
    consoleErrors: await countConsoleErrors(repoRoot, paths.consoleSinkPath),
    pageErrors: await countEvents(repoRoot, paths.pageErrorSinkPath),
    networkFailures: await countEvents(repoRoot, paths.networkSinkPath),
  };
}

export function diffEventDeltaSummary(
  before: EventDeltaBaseline,
  after: EventDeltaBaseline,
): EventDeltaSummary {
  return {
    newConsoleErrors: Math.max(0, after.consoleErrors - before.consoleErrors),
    newPageErrors: Math.max(0, after.pageErrors - before.pageErrors),
    newNetworkFailures: Math.max(0, after.networkFailures - before.networkFailures),
  };
}

async function countConsoleErrors(
  repoRoot: string,
  relativePath: string | undefined,
): Promise<number> {
  const events = await readNdjson(repoRoot, relativePath);
  return events.filter((event) => event.type === 'console' && event.level === 'error').length;
}

async function countEvents(
  repoRoot: string,
  relativePath: string | undefined,
): Promise<number> {
  const events = await readNdjson(repoRoot, relativePath);
  return events.length;
}

async function readNdjson(
  repoRoot: string,
  relativePath: string | undefined,
): Promise<Array<Record<string, unknown>>> {
  if (!relativePath) {
    return [];
  }

  try {
    return (await readEventSinkFamily(repoRoot, relativePath)).map(record => record.payload);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT'
    ) {
      return [];
    }

    throw error;
  }
}
