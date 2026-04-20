export interface CorrelationEventRecord {
  eventId: string;
  category: 'action' | 'console' | 'page-error' | 'network' | 'devserver-stdout' | 'devserver-stderr';
  sinkPath: string;
  lineNumber: number;
  payload: Record<string, unknown>;
}

export interface CorrelationCheckpointRecord {
  checkpointId: string;
  name: string;
  manifestPath: string;
  artifactPaths: string[];
  createdAt: string;
  url: string;
}

export interface RootCauseHypothesis {
  hypothesisId: string;
  confidence: number;
  statement: string;
  evidenceEventIds: string[];
  evidenceArtifactPaths: string[];
}

export interface RootCauseCorrelationResult {
  hypotheses: RootCauseHypothesis[];
  unresolvedReason?: string;
}

export interface CorrelateRootCauseInput {
  actions: CorrelationEventRecord[];
  consoleEvents: CorrelationEventRecord[];
  pageErrors: CorrelationEventRecord[];
  networkEvents: CorrelationEventRecord[];
  checkpoints: CorrelationCheckpointRecord[];
}

const UNDEFINED_PROPERTY_PATTERN =
  /Cannot read properties of undefined \(reading ['"](?<property>[^'"]+)['"]\)/i;

export function correlateRootCause(
  input: CorrelateRootCauseInput,
): RootCauseCorrelationResult {
  const checkpoints = [...input.checkpoints].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  const latestCheckpoint = checkpoints.at(-1);

  const planConsoleEvent = input.consoleEvents.find((event) =>
    getConsoleMessage(event).match(/reading ['"]plan['"]/i),
  );
  const planPageError = input.pageErrors.find((event) =>
    getPageErrorMessage(event).match(/reading ['"]plan['"]/i),
  );
  const submitAction = input.actions.find((event) =>
    `${getString(event.payload.action)} ${getString(event.payload.query)} ${getString(event.payload.targetElementId)}`
      .toLowerCase()
      .match(/\b(submit|order|checkout)\b/),
  );
  const submitNetworkEvent = input.networkEvents.find((event) =>
    `${getString(event.payload.url)} ${getString(event.payload.method)} ${getString(event.payload.pageUrl)}`
      .toLowerCase()
      .match(/\b(submit|order|checkout)\b/),
  );

  if (planConsoleEvent && submitNetworkEvent) {
    return {
      hypotheses: [
        {
          hypothesisId: 'rh_submit_plan',
          confidence: submitAction ? 0.9 : 0.87,
          statement: 'The submit handler reads a missing plan object after the order form submit.',
          evidenceEventIds: [planConsoleEvent.eventId, submitNetworkEvent.eventId],
          evidenceArtifactPaths: dedupeStrings([
            latestCheckpoint?.manifestPath,
            ...(latestCheckpoint?.artifactPaths ?? []).slice(0, 2),
          ].filter(isPresent)),
        },
      ],
    };
  }

  const genericPropertyEvent = planConsoleEvent
    ?? input.consoleEvents.find((event) => UNDEFINED_PROPERTY_PATTERN.test(getConsoleMessage(event)))
    ?? planPageError
    ?? input.pageErrors.find((event) => UNDEFINED_PROPERTY_PATTERN.test(getPageErrorMessage(event)));

  if (genericPropertyEvent) {
    const message = genericPropertyEvent.category === 'page-error'
      ? getPageErrorMessage(genericPropertyEvent)
      : getConsoleMessage(genericPropertyEvent);
    const propertyMatch = message.match(UNDEFINED_PROPERTY_PATTERN);
    const property = propertyMatch?.groups?.property?.toLowerCase() ?? 'state';

    return {
      hypotheses: [
        {
          hypothesisId: `rh_missing_${normalizeSegment(property)}`,
          confidence: 0.72,
          statement: `A runtime handler reads a missing ${property} value before the page finishes the current flow.`,
          evidenceEventIds: [genericPropertyEvent.eventId],
          evidenceArtifactPaths: dedupeStrings([
            latestCheckpoint?.manifestPath,
            latestCheckpoint?.artifactPaths[0],
          ].filter(isPresent)),
        },
      ],
    };
  }

  return {
    hypotheses: [],
    unresolvedReason: 'Insufficient evidence to assert a root cause.',
  };
}

function getConsoleMessage(event: CorrelationEventRecord): string {
  return getString(event.payload.text);
}

function getPageErrorMessage(event: CorrelationEventRecord): string {
  return getString(event.payload.message);
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeSegment(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isPresent<TValue>(value: TValue | null | undefined): value is TValue {
  return value !== null && value !== undefined;
}
