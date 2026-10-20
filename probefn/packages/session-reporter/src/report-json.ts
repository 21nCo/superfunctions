import { readEventSinkFamily } from '@probefn/storage';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  SCHEMA_VERSION,
  type CheckpointManifest,
  type RunManifest,
  type SchemaVersion,
} from '@probefn/contracts';
import {
  auditDesignBundle,
  correlateRootCause,
  loadCheckpointAuditBundle,
  type CorrelationCheckpointRecord,
  type CorrelationEventRecord,
  type DesignFinding,
  type RootCauseHypothesis,
} from '@probefn/analyzers';

export interface SessionStateLike {
  sessionId: string;
  runId: string;
  mode: string;
  browser: string;
  artifactRoot: string;
  startedAt: string;
  endedAt?: string;
  status: string;
  deterministic: Record<string, unknown>;
  resolvedUrl?: string;
  artifacts: {
    manifestPath: string;
    tracePath?: string | null;
    reportJsonPath?: string;
    reportMarkdownPath?: string;
    consoleSinkPath?: string;
    pageErrorSinkPath?: string;
    networkSinkPath?: string;
    devServerStdoutSinkPath?: string;
    devServerStderrSinkPath?: string;
  };
}

export interface IndexedRuntimeEvent extends CorrelationEventRecord {
  ts?: string;
}

export interface CheckpointIndexEntry {
  checkpointId: string;
  name: string;
  manifestPath: string;
  url: string;
  viewport: {
    width: number;
    height: number;
  };
  unstable: boolean;
  createdAt: string;
  artifacts: CheckpointManifest['artifacts'];
}

export interface RegressionIndexEntry {
  baselineKey: string;
  summaryPath: string;
  diffPath: string;
  pixelDiffPercent: number;
  changedPixels: number;
  totalPixels: number;
}

export interface ArtifactReferences {
  manifestPath: string;
  tracePath: string | null;
  eventSinks: {
    actions?: string;
    console?: string;
    pageErrors?: string;
    network?: string;
    devServerStdout?: string;
    devServerStderr?: string;
  };
  checkpoints: string[];
  diffs: string[];
  reports: {
    json?: string;
    markdown?: string;
  };
}

export interface ReportJsonDocument {
  schemaVersion: SchemaVersion;
  runMetadata: RunManifest;
  checkpointIndex: CheckpointIndexEntry[];
  eventIndex: {
    actions: IndexedRuntimeEvent[];
    console: IndexedRuntimeEvent[];
    pageErrors: IndexedRuntimeEvent[];
    network: IndexedRuntimeEvent[];
    devServerStdout: IndexedRuntimeEvent[];
    devServerStderr: IndexedRuntimeEvent[];
  };
  findings: DesignFinding[];
  regressions: RegressionIndexEntry[];
  hypotheses: RootCauseHypothesis[];
  unresolvedReason?: string;
  tracePath: string | null;
  artifactReferences: ArtifactReferences;
}

export interface BuildReportJsonResult {
  report: ReportJsonDocument;
  warnings: string[];
  includes: string[];
}

interface DiffManifest {
  baselineKey: string;
  pixelDiffPercent: number;
  changedPixels: number;
  totalPixels: number;
}

const ACTION_SINK_PATH = 'events/actions.ndjson';

export async function buildReportJson(
  input: {
    repoRoot: string;
    session: SessionStateLike;
  },
): Promise<BuildReportJsonResult> {
  const runManifest = await readJson<RunManifest>(
    path.resolve(input.repoRoot, input.session.artifacts.manifestPath),
  );
  const checkpointIndex = await readCheckpointIndex(input.repoRoot, input.session.artifactRoot);
  const designSummary = await collectDesignFindings(
    input.repoRoot,
    input.session.artifactRoot,
    checkpointIndex,
  );
  const regressions = await readRegressionIndex(input.repoRoot, input.session.artifactRoot);

  const actionSinkPath = path.posix.join(input.session.artifactRoot, ACTION_SINK_PATH);
  const actions = await readIndexedEvents(input.repoRoot, actionSinkPath, 'action', 'evt_action');
  const consoleEvents = await readIndexedEvents(
    input.repoRoot,
    input.session.artifacts.consoleSinkPath,
    'console',
    'evt_console',
  );
  const pageErrors = await readIndexedEvents(
    input.repoRoot,
    input.session.artifacts.pageErrorSinkPath,
    'page-error',
    'evt_page',
  );
  const network = await readIndexedEvents(
    input.repoRoot,
    input.session.artifacts.networkSinkPath,
    'network',
    'evt_network',
  );
  const devServerStdout = await readIndexedEvents(
    input.repoRoot,
    input.session.artifacts.devServerStdoutSinkPath,
    'devserver-stdout',
    'evt_devserver_stdout',
  );
  const devServerStderr = await readIndexedEvents(
    input.repoRoot,
    input.session.artifacts.devServerStderrSinkPath,
    'devserver-stderr',
    'evt_devserver_stderr',
  );

  const tracePath = await resolveTracePath(
    input.repoRoot,
    input.session.artifacts.tracePath ?? null,
  );
  const warnings = [
    ...designSummary.warnings,
    ...(tracePath ? [] : ['Trace artifact was not recorded for this run.']),
  ];

  const correlation = correlateRootCause({
    actions,
    consoleEvents,
    pageErrors,
    networkEvents: network,
    checkpoints: checkpointIndex.map(toCorrelationCheckpoint),
  });

  return {
    report: {
      schemaVersion: SCHEMA_VERSION,
      runMetadata: runManifest,
      checkpointIndex,
      eventIndex: {
        actions,
        console: consoleEvents,
        pageErrors,
        network,
        devServerStdout,
        devServerStderr,
      },
      findings: designSummary.findings,
      regressions,
      hypotheses: correlation.hypotheses,
      ...(correlation.unresolvedReason
        ? { unresolvedReason: correlation.unresolvedReason }
        : {}),
      tracePath,
      artifactReferences: {
        manifestPath: input.session.artifacts.manifestPath,
        tracePath,
        eventSinks: {
          ...(actions.length > 0 ? { actions: actionSinkPath } : {}),
          ...(input.session.artifacts.consoleSinkPath ? { console: input.session.artifacts.consoleSinkPath } : {}),
          ...(input.session.artifacts.pageErrorSinkPath ? { pageErrors: input.session.artifacts.pageErrorSinkPath } : {}),
          ...(input.session.artifacts.networkSinkPath ? { network: input.session.artifacts.networkSinkPath } : {}),
          ...(input.session.artifacts.devServerStdoutSinkPath ? { devServerStdout: input.session.artifacts.devServerStdoutSinkPath } : {}),
          ...(input.session.artifacts.devServerStderrSinkPath ? { devServerStderr: input.session.artifacts.devServerStderrSinkPath } : {}),
        },
        checkpoints: checkpointIndex.map((checkpoint) => checkpoint.manifestPath),
        diffs: regressions.map((regression) => regression.summaryPath),
        reports: {
          ...(input.session.artifacts.reportJsonPath ? { json: input.session.artifacts.reportJsonPath } : {}),
          ...(input.session.artifacts.reportMarkdownPath ? { markdown: input.session.artifacts.reportMarkdownPath } : {}),
        },
      },
    },
    warnings,
    includes: [
      'runMetadata',
      'checkpointIndex',
      'findings',
      'regressions',
      'hypotheses',
      'artifactReferences',
    ],
  };
}

async function readCheckpointIndex(
  repoRoot: string,
  artifactRoot: string,
): Promise<CheckpointIndexEntry[]> {
  const checkpointRoot = path.resolve(repoRoot, artifactRoot, 'checkpoints');
  const entries = await safeReaddir(checkpointRoot);

  const checkpoints: CheckpointIndexEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifestAbsolutePath = path.resolve(checkpointRoot, entry.name, 'checkpoint.json');
    try {
      const manifest = await readJson<CheckpointManifest>(manifestAbsolutePath);
      checkpoints.push({
        checkpointId: manifest.checkpointId,
        name: manifest.name,
        manifestPath: toRepoRelative(repoRoot, manifestAbsolutePath),
        url: manifest.url,
        viewport: manifest.viewport,
        unstable: manifest.unstable === true,
        createdAt: manifest.createdAt,
        artifacts: manifest.artifacts,
      });
    } catch {
      continue;
    }
  }

  return checkpoints.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

async function collectDesignFindings(
  repoRoot: string,
  artifactRoot: string,
  checkpoints: CheckpointIndexEntry[],
): Promise<{
  findings: DesignFinding[];
  warnings: string[];
}> {
  const findings: DesignFinding[] = [];
  const warnings: string[] = [];

  for (const checkpoint of checkpoints) {
    try {
      const bundle = await loadCheckpointAuditBundle({
        repoRoot,
        artifactRoot,
        checkpointId: checkpoint.checkpointId,
      });
      const audit = auditDesignBundle(bundle, {
        warnOnMissingTokenMap: false,
      });
      findings.push(...audit.findings);
      warnings.push(...audit.warnings);
    } catch {
      continue;
    }
  }

  return {
    findings: dedupeBySignature(findings, (finding) => `${finding.category}:${finding.summary}`),
    warnings: dedupeBySignature(warnings, (warning) => warning),
  };
}

async function readRegressionIndex(
  repoRoot: string,
  artifactRoot: string,
): Promise<RegressionIndexEntry[]> {
  const diffRoot = path.resolve(repoRoot, artifactRoot, 'diffs');
  const directories = await safeReaddir(diffRoot);
  const regressions: RegressionIndexEntry[] = [];

  for (const directory of directories) {
    if (!directory.isDirectory()) {
      continue;
    }

    const summaryPath = path.resolve(diffRoot, directory.name, 'diff.json');
    try {
      const summary = await readJson<DiffManifest>(summaryPath);
      regressions.push({
        baselineKey: summary.baselineKey,
        summaryPath: toRepoRelative(repoRoot, summaryPath),
        diffPath: path.posix.join(toRepoRelative(repoRoot, path.resolve(diffRoot, directory.name)), 'diff.png'),
        pixelDiffPercent: summary.pixelDiffPercent,
        changedPixels: summary.changedPixels,
        totalPixels: summary.totalPixels,
      });
    } catch {
      continue;
    }
  }

  return regressions.sort((left, right) => left.baselineKey.localeCompare(right.baselineKey));
}

async function readIndexedEvents(
  repoRoot: string,
  relativePath: string | undefined,
  category: CorrelationEventRecord['category'],
  prefix: string,
): Promise<IndexedRuntimeEvent[]> {
  if (!relativePath) {
    return [];
  }

  try {
    const records = await readEventSinkFamily(repoRoot, relativePath);
    return records.map((record, index) => {
      const payload = record.payload;
      const ts = typeof payload.ts === 'string' ? payload.ts : undefined;
      return {
        eventId: `${prefix}_${index + 1}`,
        category,
        sinkPath: record.relativePath,
        lineNumber: record.lineNumber,
        payload,
        ...(ts ? { ts } : {}),
      };
    });
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }

    throw error;
  }
}

async function resolveTracePath(
  repoRoot: string,
  tracePath: string | null,
): Promise<string | null> {
  if (!tracePath) {
    return null;
  }

  try {
    await access(path.resolve(repoRoot, tracePath));
    return tracePath;
  } catch {
    return null;
  }
}

async function safeReaddir(absolutePath: string) {
  try {
    return await readdir(absolutePath, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }

    throw error;
  }
}

function toCorrelationCheckpoint(checkpoint: CheckpointIndexEntry): CorrelationCheckpointRecord {
  return {
    checkpointId: checkpoint.checkpointId,
    name: checkpoint.name,
    manifestPath: checkpoint.manifestPath,
    artifactPaths: checkpoint.artifacts.map((artifact: CheckpointManifest['artifacts'][number]) => artifact.path),
    createdAt: checkpoint.createdAt,
    url: checkpoint.url,
  };
}

function toRepoRelative(repoRoot: string, absolutePath: string): string {
  return path.relative(repoRoot, absolutePath).split(path.sep).join(path.posix.sep);
}

async function readJson<TValue>(absolutePath: string): Promise<TValue> {
  return JSON.parse(await readFile(absolutePath, 'utf8')) as TValue;
}

function isMissing(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT',
  );
}

function dedupeBySignature<TValue>(
  values: TValue[],
  signature: (value: TValue) => string,
): TValue[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const next = signature(value);
    if (seen.has(next)) {
      return false;
    }

    seen.add(next);
    return true;
  });
}
