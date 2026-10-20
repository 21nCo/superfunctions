import { iterateEventSinkFamily } from '@probefn/storage';

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

async function countConsoleErrors(repoRoot: string, relativePath: string | undefined): Promise<number> {
  return countMatchingEvents(repoRoot, relativePath, event => event !== null && typeof event === 'object' && event.type === 'console' && event.level === 'error');
}

async function countEvents(repoRoot: string, relativePath: string | undefined): Promise<number> {
  return countMatchingEvents(repoRoot, relativePath, () => true);
}

async function countMatchingEvents(
  repoRoot: string,
  relativePath: string | undefined,
  matches: (event: Record<string, unknown>) => boolean,
): Promise<number> {
  if (!relativePath) return 0;
  let count = 0;
  try {
    for await (const record of iterateEventSinkFamily(repoRoot, relativePath)) {
      if (matches(record.payload)) count++;
    }
    return count;
  } catch (error) {
    // Only an absent anchor represents a sink with no events. Never discard a partial scan.
    if (count === 0 && error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return 0;
    throw error;
  }
}
