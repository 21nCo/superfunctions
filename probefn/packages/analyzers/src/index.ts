import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { createProbefnError, type CheckpointManifest, type RunManifest } from '@probefn/contracts';

import { analyzeAlignment } from './design/alignment.js';
import { analyzeClippingFallback } from './design/clipping.js';
import { analyzeFocusStates } from './design/focus.js';
import { analyzeOverflowAndClipping } from './design/overflow.js';
import { analyzeResponsive } from './design/responsive.js';
import { DESIGN_SEVERITY_POLICY, type AnalyzerResult, type DesignAuditBundle, type DesignFinding, type DesignTokenMap } from './design/shared.js';
import { analyzeSpacing } from './design/spacing.js';
import { analyzeTokenDrift } from './design/token-drift.js';
import { analyzeTouchTargets } from './design/touch-targets.js';
import {
  correlateRootCause,
  type CorrelationCheckpointRecord,
  type CorrelationEventRecord,
  type RootCauseCorrelationResult,
  type RootCauseHypothesis,
} from './correlation/root-cause.js';

export const ANALYZERS_PACKAGE_NAME = '@probefn/analyzers';
export { DESIGN_SEVERITY_POLICY };
export type {
  AnalyzerResult,
  DesignAuditBundle,
  DesignFinding,
  DesignTokenMap,
} from './design/shared.js';
export {
  correlateRootCause,
};
export type {
  CorrelationCheckpointRecord,
  CorrelationEventRecord,
  RootCauseCorrelationResult,
  RootCauseHypothesis,
};

export interface AuditDesignOptions {
  tokenMap?: DesignTokenMap;
  warnOnMissingTokenMap?: boolean;
}

export async function loadCheckpointAuditBundle(input: {
  repoRoot: string;
  artifactRoot: string;
  checkpointId: string;
}): Promise<DesignAuditBundle> {
  const runRoot = path.resolve(input.repoRoot, input.artifactRoot);
  const checkpointRoot = path.resolve(runRoot, 'checkpoints');
  const checkpointDirectories = await readdir(checkpointRoot, {
    withFileTypes: true,
  });

  let checkpointManifestPath: string | null = null;
  let checkpointManifest: CheckpointManifest | null = null;
  for (const entry of checkpointDirectories) {
    if (!entry.isDirectory()) {
      continue;
    }

    const candidateManifestPath = path.resolve(checkpointRoot, entry.name, 'checkpoint.json');
    try {
      const candidateManifest = await readJson<CheckpointManifest>(candidateManifestPath);
      if (candidateManifest.checkpointId === input.checkpointId) {
        checkpointManifestPath = candidateManifestPath;
        checkpointManifest = candidateManifest;
        break;
      }
    } catch {
      continue;
    }
  }

  if (!checkpointManifestPath || !checkpointManifest) {
    throw createProbefnError({
      code: 'E_STORAGE_WRITE_FAILED',
      message: `Checkpoint ${input.checkpointId} was not found under ${input.artifactRoot}.`,
      retryable: false,
      details: {
        checkpointId: input.checkpointId,
      },
    });
  }

  const runManifest = await readJson<RunManifest>(path.resolve(runRoot, 'session.json'));
  const artifactIndex = new Map(
    checkpointManifest.artifacts.map((artifact) => [artifact.kind, artifact.path]),
  );
  const layoutRelativePath = artifactIndex.get('layout');
  if (!layoutRelativePath) {
    throw createProbefnError({
      code: 'E_ANALYZER_FAILURE',
      message: `Checkpoint ${input.checkpointId} does not include layout metadata.`,
      retryable: false,
    });
  }

  const stylesRelativePath = artifactIndex.get('styles');
  return {
    sessionId: checkpointManifest.sessionId,
    checkpointId: checkpointManifest.checkpointId,
    checkpointPath: toRepoRelative(input.repoRoot, checkpointManifestPath),
    layoutPath: layoutRelativePath,
    viewport: checkpointManifest.viewport,
    layout: await readJson(path.resolve(input.repoRoot, layoutRelativePath)),
    ...(stylesRelativePath
      ? { styles: await readJson(path.resolve(input.repoRoot, stylesRelativePath)) }
      : {}),
    unstable: checkpointManifest.unstable === true || runManifest.unstable === true,
  };
}

export function auditDesignBundle(
  bundle: DesignAuditBundle,
  options: AuditDesignOptions = {},
): AnalyzerResult {
  const findings: DesignFinding[] = [];
  const warnings: string[] = [];

  const overflowFindings = analyzeOverflowAndClipping(bundle);
  findings.push(...overflowFindings);
  findings.push(...analyzeClippingFallback(bundle));
  findings.push(...analyzeSpacing(bundle));
  findings.push(...analyzeAlignment(bundle));
  findings.push(...analyzeResponsive(bundle, overflowFindings));

  const tokenAndContrast = analyzeTokenDrift(bundle, options.tokenMap, {
    ...(options.warnOnMissingTokenMap !== undefined
      ? { warnOnMissingTokenMap: options.warnOnMissingTokenMap }
      : {}),
  });
  findings.push(...tokenAndContrast.findings);
  warnings.push(...tokenAndContrast.warnings);

  findings.push(...analyzeFocusStates(bundle));
  findings.push(...analyzeTouchTargets(bundle));

  if (bundle.unstable) {
    warnings.push(`Checkpoint ${bundle.checkpointId} was captured during dev-server instability.`);
  }

  return {
    findings: dedupeFindings(findings),
    warnings: dedupeStrings(warnings),
  };
}

export function extractDesignTokenMap(
  analyzersConfig: unknown,
): DesignTokenMap | undefined {
  if (
    analyzersConfig &&
    typeof analyzersConfig === 'object' &&
    'design' in analyzersConfig
  ) {
    const designConfig = (analyzersConfig as { design?: unknown }).design;
    if (
      designConfig &&
      typeof designConfig === 'object' &&
      'tokenMap' in designConfig
    ) {
      return (designConfig as { tokenMap?: DesignTokenMap }).tokenMap;
    }
  }

  return undefined;
}

function dedupeFindings(findings: DesignFinding[]): DesignFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const signature = `${finding.category}:${finding.summary}`;
    if (seen.has(signature)) {
      return false;
    }

    seen.add(signature);
    return true;
  });
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function toRepoRelative(repoRoot: string, absolutePath: string): string {
  return path.relative(repoRoot, absolutePath).split(path.sep).join(path.posix.sep);
}

async function readJson<T>(absolutePath: string): Promise<T> {
  return JSON.parse(await readFile(absolutePath, 'utf8')) as T;
}

export { createCorrelationAccumulator } from './correlation/root-cause.js';
