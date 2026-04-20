import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createProbefnError, type DeterministicSettings } from '@probefn/contracts';

import {
  DEFAULT_BASELINE_ROOT,
  getBaselineEntry,
  loadCheckpointArtifacts,
  recordBaseline,
  type BaselineRegistryEntry,
  type RecordBaselineInput,
  type RecordBaselineResult,
} from './baseline-registry.js';
import {
  buildBaselineKey,
  inferViewportTag,
  parseBaselineKey,
  type BaselineKeyParts,
} from './baseline-key.js';
import { diffScreenshots } from './pixel-diff.js';
import { diffSemanticLayouts, type RegressionFinding } from './semantic-diff.js';

export const VISUAL_BASELINES_PACKAGE_NAME = '@probefn/visual-baselines';
export {
  DEFAULT_BASELINE_ROOT,
  buildBaselineKey,
  inferViewportTag,
  parseBaselineKey,
  recordBaseline,
};
export type {
  BaselineKeyParts,
  BaselineRegistryEntry,
  RecordBaselineInput,
  RecordBaselineResult,
  RegressionFinding,
};

export interface CompareBaselineInput {
  repoRoot: string;
  artifactRoot: string;
  baselineRoot?: string;
  checkpointId: string;
  baselineKey: string;
  runId: string;
}

export interface CompareBaselineResult {
  baselineKey: string;
  status: 'pass' | 'fail';
  pixelDiffPercent: number;
  findings: RegressionFinding[];
}

export async function compareBaseline(
  input: CompareBaselineInput,
): Promise<CompareBaselineResult> {
  const baselineRoot = input.baselineRoot ?? DEFAULT_BASELINE_ROOT;
  const baselineEntry = await getBaselineEntry(
    input.repoRoot,
    baselineRoot,
    input.baselineKey,
  );
  const currentCheckpoint = await loadCheckpointArtifacts({
    repoRoot: input.repoRoot,
    artifactRoot: input.artifactRoot,
    checkpointId: input.checkpointId,
  });

  assertMatchingDimensions(input.baselineKey, baselineEntry, currentCheckpoint.manifest.viewport);

  const baselineScreenshot = await readFile(
    path.resolve(input.repoRoot, baselineEntry.artifacts.screenshotPath),
  );
  const currentScreenshotPath = currentCheckpoint.artifactPaths.screenshot;
  if (!currentScreenshotPath) {
    throw createProbefnError({
      code: 'E_STORAGE_WRITE_FAILED',
      message: `Checkpoint ${input.checkpointId} is missing required screenshot artifact.`,
      retryable: false,
    });
  }

  const currentScreenshot = await readFile(
    path.resolve(input.repoRoot, currentScreenshotPath),
  );
  const pixelDiff = diffScreenshots(
    baselineScreenshot,
    currentScreenshot,
  );

  const diffPath = await writeDiffArtifacts(
    input.repoRoot,
    input.artifactRoot,
    input.runId,
    input.baselineKey,
    pixelDiff,
  );

  const baselineLayout = JSON.parse(
    await readFile(path.resolve(input.repoRoot, baselineEntry.artifacts.layoutPath), 'utf8'),
  ) as {
    elements: Array<{
      elementId: string;
      role: string;
      name: string;
      text: string;
      visible: boolean;
      disabled: boolean;
      bounds: { x: number; y: number; width: number; height: number };
      selectorHints: { id?: string; testId?: string; role?: string; name?: string };
    }>;
  };
  const currentLayoutPath = currentCheckpoint.artifactPaths.layout;
  if (!currentLayoutPath) {
    throw createProbefnError({
      code: 'E_STORAGE_WRITE_FAILED',
      message: `Checkpoint ${input.checkpointId} is missing required layout artifact.`,
      retryable: false,
    });
  }

  const currentLayout = JSON.parse(
    await readFile(path.resolve(input.repoRoot, currentLayoutPath), 'utf8'),
  ) as typeof baselineLayout;

  const findings = diffSemanticLayouts({
    baselineKey: input.baselineKey,
    baselineLayout,
    currentLayout,
    baselineLayoutPath: baselineEntry.artifacts.layoutPath,
    currentLayoutPath,
    diffPath,
  });

  if (findings.length === 0 && pixelDiff.pixelDiffPercent > 0) {
    findings.push({
      findingId: 'rf_pixel_drift',
      severity: pixelDiff.pixelDiffPercent >= 1 ? 'medium' : 'low',
      category: 'pixel-drift',
      summary: `Cosmetic pixel drift of ${pixelDiff.pixelDiffPercent.toFixed(1)}% was detected without structural regressions.`,
      evidenceReferences: [diffPath],
      baselineKey: input.baselineKey,
    });
  }

  return {
    baselineKey: input.baselineKey,
    status: findings.length === 0 ? 'pass' : 'fail',
    pixelDiffPercent: pixelDiff.pixelDiffPercent,
    findings,
  };
}

export function buildDeterministicBaselineKey(input: {
  routeIdentity: string;
  viewport: {
    width: number;
    height: number;
  };
  browser: BaselineKeyParts['browser'];
  deterministic: DeterministicSettings;
}): string {
  return buildBaselineKey({
    routeIdentity: input.routeIdentity,
    viewportTag: inferViewportTag(input.viewport),
    browser: input.browser,
    colorScheme: input.deterministic.colorScheme,
    width: input.viewport.width,
    height: input.viewport.height,
    timezoneTag: input.deterministic.timezone.toLowerCase(),
  });
}

async function writeDiffArtifacts(
  repoRoot: string,
  artifactRoot: string,
  _runId: string,
  baselineKey: string,
  pixelDiff: {
    diffPng: Buffer;
    pixelDiffPercent: number;
    changedPixels: number;
    totalPixels: number;
  },
): Promise<string> {
  const diffDirectory = path.resolve(
    repoRoot,
    artifactRoot,
    'diffs',
    sanitizeBaselineKey(baselineKey),
  );
  await mkdir(diffDirectory, { recursive: true });

  const diffPngPath = path.join(diffDirectory, 'diff.png');
  const diffJsonPath = path.join(diffDirectory, 'diff.json');
  await writeFile(diffPngPath, pixelDiff.diffPng);
  await writeFile(
    diffJsonPath,
    `${JSON.stringify(
      {
        baselineKey,
        pixelDiffPercent: pixelDiff.pixelDiffPercent,
        changedPixels: pixelDiff.changedPixels,
        totalPixels: pixelDiff.totalPixels,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return toRepoRelative(repoRoot, diffPngPath);
}

function assertMatchingDimensions(
  baselineKey: string,
  baselineEntry: BaselineRegistryEntry,
  checkpointViewport: {
    width: number;
    height: number;
  },
): void {
  const parsedKey = parseBaselineKey(baselineKey);
  const baselineDimensions = baselineEntry.dimensions;

  const mismatch =
    parsedKey.width !== checkpointViewport.width ||
    parsedKey.height !== checkpointViewport.height ||
    baselineDimensions.width !== checkpointViewport.width ||
    baselineDimensions.height !== checkpointViewport.height;

  if (mismatch) {
    throw createProbefnError({
      code: 'E_BASELINE_MISMATCH',
      message: 'Baseline dimensions do not match the checkpoint dimensions.',
      retryable: false,
      details: {
        baselineKey,
        baselineDimensions: `${baselineDimensions.width}x${baselineDimensions.height}`,
        checkpointDimensions: `${checkpointViewport.width}x${checkpointViewport.height}`,
      },
    });
  }
}

function sanitizeBaselineKey(baselineKey: string): string {
  return baselineKey.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function toRepoRelative(repoRoot: string, absolutePath: string): string {
  return path.relative(repoRoot, absolutePath).split(path.sep).join(path.posix.sep);
}
