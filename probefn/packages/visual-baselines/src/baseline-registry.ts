import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  auditDesignBundle,
  loadCheckpointAuditBundle,
  type DesignFinding,
} from '@probefn/analyzers';
import { createProbefnError, SCHEMA_VERSION, type BrowserEngine, type CheckpointManifest, type DeterministicSettings } from '@probefn/contracts';
import { filterSensitiveExportData } from '@probefn/storage';

import { parseBaselineKey, type BaselineKeyParts, type ColorScheme, type ViewportTag } from './baseline-key.js';

export const DEFAULT_BASELINE_ROOT = '.artifacts/baselines';

export interface BaselineRegistry {
  schemaVersion: typeof SCHEMA_VERSION;
  replacementPolicy: 'replace';
  entries: BaselineRegistryEntry[];
}

export interface BaselineRegistryEntry {
  baselineKey: string;
  routeIdentity: string;
  viewportTag: ViewportTag;
  browser: BrowserEngine;
  colorScheme: ColorScheme;
  dimensions: {
    width: number;
    height: number;
  };
  timezoneTag: string;
  sourceSessionId: string;
  sourceRunId: string;
  sourceCheckpointId: string;
  sourceCheckpointPath: string;
  deterministic: DeterministicSettings;
  artifacts: BaselineArtifactIndex;
  analyzerSummary: {
    findings: DesignFinding[];
    warnings: string[];
  };
  recordedAt: string;
}

export interface BaselineArtifactIndex {
  checkpointManifestPath: string;
  screenshotPath: string;
  domPath: string;
  axPath: string;
  layoutPath: string;
  stylesPath?: string;
}

export interface LoadedCheckpointArtifacts {
  manifest: CheckpointManifest;
  manifestPath: string;
  artifactPaths: Record<string, string>;
}

export interface RecordBaselineInput {
  repoRoot: string;
  artifactRoot: string;
  baselineRoot?: string;
  checkpointId: string;
  baselineKey: string;
  sessionId: string;
  runId: string;
  deterministic: DeterministicSettings;
  now?: () => string;
}

export interface RecordBaselineResult {
  baselineKey: string;
  registryPath: string;
  sourceCheckpointId: string;
  warnings: string[];
}

export async function recordBaseline(
  input: RecordBaselineInput,
): Promise<RecordBaselineResult> {
  const baselineRoot = normalizeRepoRelativePath(input.baselineRoot ?? DEFAULT_BASELINE_ROOT);
  const parsedKey = parseBaselineKey(input.baselineKey);
  const checkpoint = await loadCheckpointArtifacts({
    repoRoot: input.repoRoot,
    artifactRoot: input.artifactRoot,
    checkpointId: input.checkpointId,
  });
  const now = input.now ?? (() => new Date().toISOString());
  const warnings: string[] = [];

  if (
    parsedKey.width !== checkpoint.manifest.viewport.width ||
    parsedKey.height !== checkpoint.manifest.viewport.height
  ) {
    warnings.push(
      'Baseline key dimensions differ from checkpoint viewport; a distinct baseline entry was recorded.',
    );
  }

  const entryRoot = path.posix.join(
    baselineRoot,
    'entries',
    sanitizeBaselineKey(input.baselineKey),
  );
  const copiedArtifacts = await copyCheckpointArtifacts(
    input.repoRoot,
    entryRoot,
    checkpoint,
  );

  const analyzerBundle = await loadCheckpointAuditBundle({
    repoRoot: input.repoRoot,
    artifactRoot: input.artifactRoot,
    checkpointId: input.checkpointId,
  });
  const analyzerSummary = auditDesignBundle(analyzerBundle);

  const entry: BaselineRegistryEntry = {
    baselineKey: input.baselineKey,
    routeIdentity: parsedKey.routeIdentity,
    viewportTag: parsedKey.viewportTag,
    browser: checkpoint.manifest.browser,
    colorScheme: input.deterministic.colorScheme,
    dimensions: checkpoint.manifest.viewport,
    timezoneTag: parsedKey.timezoneTag,
    sourceSessionId: input.sessionId,
    sourceRunId: input.runId,
    sourceCheckpointId: checkpoint.manifest.checkpointId,
    sourceCheckpointPath: checkpoint.manifestPath,
    deterministic: input.deterministic,
    artifacts: copiedArtifacts,
    analyzerSummary,
    recordedAt: now(),
  };

  const registry = await readBaselineRegistry(input.repoRoot, baselineRoot);
  const nextEntries = registry.entries.filter(
    (candidate) => candidate.baselineKey !== input.baselineKey,
  );
  nextEntries.push(entry);
  nextEntries.sort((left, right) => left.baselineKey.localeCompare(right.baselineKey));

  const nextRegistry: BaselineRegistry = {
    schemaVersion: SCHEMA_VERSION,
    replacementPolicy: 'replace',
    entries: nextEntries,
  };

  const registryPath = path.posix.join(baselineRoot, 'registry.json');
  await writeJsonAtomic(
    input.repoRoot,
    registryPath,
    filterSensitiveExportData(nextRegistry).value,
  );

  return {
    baselineKey: input.baselineKey,
    registryPath,
    sourceCheckpointId: checkpoint.manifest.checkpointId,
    warnings,
  };
}

export async function readBaselineRegistry(
  repoRoot: string,
  baselineRoot = DEFAULT_BASELINE_ROOT,
): Promise<BaselineRegistry> {
  const registryPath = path.resolve(repoRoot, baselineRoot, 'registry.json');
  try {
    return JSON.parse(await readFile(registryPath, 'utf8')) as BaselineRegistry;
  } catch (error) {
    if (isMissingFile(error)) {
      return {
        schemaVersion: SCHEMA_VERSION,
        replacementPolicy: 'replace',
        entries: [],
      };
    }

    throw error;
  }
}

export async function getBaselineEntry(
  repoRoot: string,
  baselineRoot: string,
  baselineKey: string,
): Promise<BaselineRegistryEntry> {
  const registry = await readBaselineRegistry(repoRoot, baselineRoot);
  const entry = registry.entries.find((candidate) => candidate.baselineKey === baselineKey);
  if (!entry) {
    throw createProbefnError({
      code: 'E_BASELINE_NOT_FOUND',
      message: `Baseline ${baselineKey} was not found.`,
      retryable: false,
      details: {
        baselineKey,
      },
    });
  }

  return entry;
}

export async function loadCheckpointArtifacts(input: {
  repoRoot: string;
  artifactRoot: string;
  checkpointId: string;
}): Promise<LoadedCheckpointArtifacts> {
  const checkpointRoot = path.resolve(input.repoRoot, input.artifactRoot, 'checkpoints');
  const directoryEntries = await import('node:fs/promises').then(({ readdir }) =>
    readdir(checkpointRoot, { withFileTypes: true }),
  );

  for (const entry of directoryEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const manifestPath = path.resolve(checkpointRoot, entry.name, 'checkpoint.json');
    try {
      const manifest = JSON.parse(
        await readFile(manifestPath, 'utf8'),
      ) as CheckpointManifest;
      if (manifest.checkpointId !== input.checkpointId) {
        continue;
      }

      return {
        manifest,
        manifestPath: toRepoRelative(input.repoRoot, manifestPath),
        artifactPaths: Object.fromEntries(
          manifest.artifacts.map((artifact: CheckpointManifest['artifacts'][number]) => [artifact.kind, artifact.path]),
        ),
      };
    } catch {
      continue;
    }
  }

  throw createProbefnError({
    code: 'E_STORAGE_WRITE_FAILED',
    message: `Checkpoint ${input.checkpointId} was not found under ${input.artifactRoot}.`,
    retryable: false,
    details: {
      checkpointId: input.checkpointId,
    },
  });
}

async function copyCheckpointArtifacts(
  repoRoot: string,
  entryRoot: string,
  checkpoint: LoadedCheckpointArtifacts,
): Promise<BaselineArtifactIndex> {
  const copied: BaselineArtifactIndex = {
    checkpointManifestPath: path.posix.join(entryRoot, 'checkpoint.json'),
    screenshotPath: path.posix.join(entryRoot, 'screenshot.png'),
    domPath: path.posix.join(entryRoot, 'dom.json'),
    axPath: path.posix.join(entryRoot, 'ax.json'),
    layoutPath: path.posix.join(entryRoot, 'layout.json'),
  };

  if (checkpoint.artifactPaths.styles) {
    copied.stylesPath = path.posix.join(entryRoot, 'styles.json');
  }

  await Promise.all([
    copyRepoRelativeFile(repoRoot, checkpoint.manifestPath, copied.checkpointManifestPath),
    copyRepoRelativeFile(repoRoot, requiredArtifact(checkpoint, 'screenshot'), copied.screenshotPath),
    copyRepoRelativeFile(repoRoot, requiredArtifact(checkpoint, 'dom'), copied.domPath),
    copyRepoRelativeFile(repoRoot, requiredArtifact(checkpoint, 'ax'), copied.axPath),
    copyRepoRelativeFile(repoRoot, requiredArtifact(checkpoint, 'layout'), copied.layoutPath),
    ...(copied.stylesPath && checkpoint.artifactPaths.styles
      ? [copyRepoRelativeFile(repoRoot, checkpoint.artifactPaths.styles, copied.stylesPath)]
      : []),
  ]);

  return copied;
}

function requiredArtifact(
  checkpoint: LoadedCheckpointArtifacts,
  kind: 'screenshot' | 'dom' | 'ax' | 'layout',
): string {
  const relativePath = checkpoint.artifactPaths[kind];
  if (!relativePath) {
    throw createProbefnError({
      code: 'E_STORAGE_WRITE_FAILED',
      message: `Checkpoint ${checkpoint.manifest.checkpointId} is missing required ${kind} artifact.`,
      retryable: false,
    });
  }

  return relativePath;
}

async function copyRepoRelativeFile(
  repoRoot: string,
  sourceRelativePath: string,
  targetRelativePath: string,
): Promise<void> {
  const sourcePath = path.resolve(repoRoot, sourceRelativePath);
  const targetPath = path.resolve(repoRoot, targetRelativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
}

function sanitizeBaselineKey(baselineKey: string): string {
  return baselineKey.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function normalizeRepoRelativePath(value: string): string {
  const normalized = value.split(path.sep).join(path.posix.sep);
  if (path.isAbsolute(normalized) || normalized.startsWith('..')) {
    throw createProbefnError({
      code: 'E_CONFIG_INVALID',
      message: `${value} must be a repository-relative path.`,
      retryable: false,
    });
  }

  return normalized;
}

async function writeJsonAtomic(
  repoRoot: string,
  relativePath: string,
  value: unknown,
): Promise<void> {
  const targetPath = path.resolve(repoRoot, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await import('node:fs/promises').then(({ rename }) => rename(tempPath, targetPath));
}

function toRepoRelative(repoRoot: string, absolutePath: string): string {
  return path.relative(repoRoot, absolutePath).split(path.sep).join(path.posix.sep);
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT',
  );
}
