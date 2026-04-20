import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { auditDesignBundle, extractDesignTokenMap, loadCheckpointAuditBundle } from '@probefn/analyzers';
import { BrowserRunner, captureStylesMetadata, captureLayoutMetadata, performPageAction, resolveSemanticTarget } from '@probefn/browser-runner';
import { loadConfig } from '@probefn/contracts/config';
import { createSuccessEnvelope } from '@probefn/contracts/envelopes';
import { toErrorEnvelope } from '@probefn/contracts/errors';
import type { CreatedCheckpoint } from '@probefn/core';
import { captureEventDeltaBaseline, checkpointSuccessEnvelope, createCheckpoint, diffEventDeltaSummary, SessionManager } from '@probefn/core';
import { ArtifactStore } from '@probefn/storage';
import { compareBaseline, DEFAULT_BASELINE_ROOT, recordBaseline } from '@probefn/visual-baselines';

import { DevServerManager } from './dev-server-manager.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repoRoot = process.cwd();

  if (args[0] === 'report' && args[1] === 'export') {
    const sessionId = getFlagValue(args, '--session');
    const format = (getFlagValue(args, '--format') ?? 'json') as 'json' | 'markdown';

    if (!sessionId) {
      throw new Error('Missing required --session flag.');
    }

    const artifactStore = new ArtifactStore({
      repoRoot,
    });
    const sessionManager = new SessionManager({
      repoRoot,
      artifactStore,
    });
    const exportedReport = await sessionManager.exportReport({
      sessionId,
      format,
    });
    const payload = createSuccessEnvelope({
      reportPath: exportedReport.reportPath,
      tracePath: exportedReport.tracePath,
      includes: exportedReport.includes,
      ...(format === 'json'
        ? {
            runMetadata: exportedReport.reportData.runMetadata,
            checkpointIndex: exportedReport.reportData.checkpointIndex,
            eventIndex: exportedReport.reportData.eventIndex,
            findings: exportedReport.reportData.findings,
            regressions: exportedReport.reportData.regressions,
            hypotheses: exportedReport.reportData.hypotheses,
            ...(exportedReport.reportData.unresolvedReason
              ? { unresolvedReason: exportedReport.reportData.unresolvedReason }
              : {}),
            artifactReferences: exportedReport.reportData.artifactReferences,
          }
        : {}),
    }, exportedReport.warnings);
    await writeToStream(process.stdout, `${JSON.stringify(payload, null, 2)}\n`);
    process.exit(0);
  }

  if (args[0] === 'page' && args[1] === 'find') {
    const sessionId = getFlagValue(args, '--session');
    const query = getFlagValue(args, '--query');
    const json = args.includes('--json');

    if (!sessionId) {
      throw new Error('Missing required --session flag.');
    }

    if (!query) {
      throw new Error('Missing required --query flag.');
    }

    const artifactStore = new ArtifactStore({
      repoRoot,
    });
    const sessionManager = new SessionManager({
      repoRoot,
      artifactStore,
    });
    const sessionState = await sessionManager.read(sessionId);
    if (!sessionState.resolvedUrl) {
      throw new Error(`Session ${sessionId} does not have a resolvedUrl.`);
    }

    const browserRunner = new BrowserRunner({
      repoRoot,
      artifactStore,
    });
    const playbackSessionId = `${sessionId}__find__${Date.now()}`;
    const startedBrowser = await browserRunner.startSession({
      sessionId: playbackSessionId,
      runId: sessionState.runId,
      browser: sessionState.browser,
      deterministic: sessionState.deterministic,
      initialUrl: sessionState.resolvedUrl,
      trace: {
        enabled: false,
      },
    });

    let stdoutValue = '';
    try {
      const resolution = await resolveSemanticTarget(startedBrowser.page, query);
      const payload = createSuccessEnvelope({
        elementId: resolution.element.elementId,
        role: resolution.element.role,
        name: resolution.element.name,
        text: resolution.element.text,
        bounds: resolution.element.bounds,
        selectorHints: resolution.element.selectorHints,
      });

      stdoutValue = json
        ? `${JSON.stringify(payload, null, 2)}\n`
        : `${resolution.element.elementId}\n`;
    } finally {
      await browserRunner.stopSession(playbackSessionId).catch(() => undefined);
    }

    await writeToStream(process.stdout, stdoutValue);
    process.exit(0);
  }

  if (args[0] === 'page' && args[1] === 'act') {
    const sessionId = getFlagValue(args, '--session');
    const action = getFlagValue(args, '--action');
    const query = getFlagValue(args, '--query');
    const selector = getFlagValue(args, '--selector');
    const value = getFlagValue(args, '--value');
    const key = getFlagValue(args, '--key');
    const json = args.includes('--json');
    const requireDomConfirmation = !args.includes('--no-dom-confirmation');

    if (!sessionId) {
      throw new Error('Missing required --session flag.');
    }

    if (!action) {
      throw new Error('Missing required --action flag.');
    }

    if (!query && !selector) {
      throw new Error('Missing required --query or --selector flag.');
    }

    const artifactStore = new ArtifactStore({
      repoRoot,
    });
    const sessionManager = new SessionManager({
      repoRoot,
      artifactStore,
    });
    const sessionState = await sessionManager.read(sessionId);
    if (!sessionState.resolvedUrl) {
      throw new Error(`Session ${sessionId} does not have a resolvedUrl.`);
    }

    const browserRunner = new BrowserRunner({
      repoRoot,
      artifactStore,
    });
    const playbackSessionId = `${sessionId}__act__${Date.now()}`;
    const startedBrowser = await browserRunner.startSession({
      sessionId: playbackSessionId,
      runId: sessionState.runId,
      browser: sessionState.browser,
      deterministic: sessionState.deterministic,
      initialUrl: sessionState.resolvedUrl,
      trace: {
        enabled: false,
      },
    });

    let stdoutValue = '';
    try {
      const actionResult = await performPageAction({
        repoRoot,
        page: startedBrowser.page,
        action: {
          kind: action as 'click' | 'fill' | 'select' | 'hover' | 'press',
          target: {
            ...(selector ? { selector } : {}),
            ...(query ? { query, requireDomConfirmation } : {}),
          },
          ...(value !== undefined ? { value } : {}),
          ...(key !== undefined ? { key } : {}),
        },
        eventPaths: startedBrowser.sinkPaths,
      });
      const payload = createSuccessEnvelope(actionResult);

      stdoutValue = json
        ? `${JSON.stringify(payload, null, 2)}\n`
        : `${actionResult.targetElementId}\n`;
    } finally {
      await browserRunner.stopSession(playbackSessionId).catch(() => undefined);
    }

    await writeToStream(process.stdout, stdoutValue);
    process.exit(0);
  }

  if (args[0] === 'checkpoint' && args[1] === 'create') {
    const sessionId = getFlagValue(args, '--session');
    const checkpointName = getFlagValue(args, '--name');
    const includeTrace = args.includes('--include-trace');
    const includeStyles = args.includes('--include-styles');
    const json = args.includes('--json');

    if (!sessionId) {
      throw new Error('Missing required --session flag.');
    }

    if (!checkpointName) {
      throw new Error('Missing required --name flag.');
    }

    const artifactStore = new ArtifactStore({
      repoRoot,
    });
    const sessionManager = new SessionManager({
      repoRoot,
      artifactStore,
    });
    const sessionState = await sessionManager.read(sessionId);
    const runManifest = await readJson<Record<string, unknown>>(
      repoRoot,
      sessionState.artifacts.manifestPath,
    );

    if (!sessionState.resolvedUrl) {
      throw new Error(`Session ${sessionId} does not have a resolvedUrl.`);
    }

    const browserRunner = new BrowserRunner({
      repoRoot,
      artifactStore,
    });
    const playbackSessionId = `${sessionId}__checkpoint__${Date.now()}`;
    const startedBrowser = await browserRunner.startSession({
      sessionId: playbackSessionId,
      runId: sessionState.runId,
      browser: sessionState.browser,
      deterministic: sessionState.deterministic,
      initialUrl: sessionState.resolvedUrl,
      trace: {
        enabled: false,
      },
    });

    const before = await captureEventDeltaBaseline(repoRoot, startedBrowser.sinkPaths);
    let checkpoint: CreatedCheckpoint | null = null;
    try {
      checkpoint = await createCheckpoint({
        repoRoot,
        artifactStore,
        sessionId: sessionState.sessionId,
        runId: sessionState.runId,
        browser: sessionState.browser,
        name: checkpointName,
        includeTrace,
        includeStyles,
        unstable: runManifest.unstable === true,
        tracePath: sessionState.artifacts.tracePath ?? null,
        delta: diffEventDeltaSummary(
          before,
          await captureEventDeltaBaseline(repoRoot, startedBrowser.sinkPaths),
        ),
        source: {
          url: () => startedBrowser.page.url(),
          viewportSize: () => startedBrowser.page.viewportSize() ?? { width: 0, height: 0 },
          screenshot: async () => startedBrowser.page.screenshot({ fullPage: true }),
          domSnapshot: async () => ({ html: await startedBrowser.page.content() }),
          accessibilitySnapshot: async () => ({
            snapshot: await startedBrowser.page.locator('body').ariaSnapshot({ mode: 'ai' }),
          }),
          layoutSnapshot: async () => captureLayoutMetadata(startedBrowser.page),
          ...(includeStyles
            ? { stylesSnapshot: async () => captureStylesMetadata(startedBrowser.page) }
            : {}),
        },
      });
    } finally {
      await browserRunner.stopSession(playbackSessionId).catch(() => undefined);
    }

    if (!checkpoint) {
      throw new Error('Checkpoint capture did not return a result.');
    }

    const payload = checkpointSuccessEnvelope(checkpoint);
    if (json) {
      await writeToStream(process.stdout, `${JSON.stringify(payload, null, 2)}\n`);
    } else {
      await writeToStream(process.stdout, `${checkpoint.checkpointId}\n`);
    }
    process.exit(0);
  }

  if (args[0] === 'audit' && args[1] === 'design') {
    const sessionId = getFlagValue(args, '--session');
    const checkpointId = getFlagValue(args, '--checkpoint');
    const configPath = getFlagValue(args, '--config');
    const json = args.includes('--json');

    if (!sessionId) {
      throw new Error('Missing required --session flag.');
    }

    if (!checkpointId) {
      throw new Error('Missing required --checkpoint flag.');
    }

    const artifactStore = new ArtifactStore({
      repoRoot,
    });
    const sessionManager = new SessionManager({
      repoRoot,
      artifactStore,
    });
    const sessionState = await sessionManager.read(sessionId);
    const bundle = await loadCheckpointAuditBundle({
      repoRoot,
      artifactRoot: sessionState.artifactRoot,
      checkpointId,
    });

    let tokenMap;
    if (configPath) {
      const config = await loadConfig(configPath, { cwd: repoRoot });
      tokenMap = extractDesignTokenMap(config.analyzers);
    }

    const result = auditDesignBundle(bundle, {
      ...(tokenMap ? { tokenMap } : {}),
      warnOnMissingTokenMap: false,
    });
    const payload = createSuccessEnvelope({
      findings: result.findings,
    }, result.warnings);

    await writeToStream(
      process.stdout,
      json ? `${JSON.stringify(payload, null, 2)}\n` : `${result.findings.length}\n`,
    );
    process.exit(0);
  }

  if (args[0] === 'baseline' && args[1] === 'record') {
    const sessionId = getFlagValue(args, '--session');
    const checkpointId = getFlagValue(args, '--checkpoint');
    const baselineKey = getFlagValue(args, '--key');
    const configPath = getFlagValue(args, '--config');
    const json = args.includes('--json');

    if (!sessionId) {
      throw new Error('Missing required --session flag.');
    }

    if (!checkpointId) {
      throw new Error('Missing required --checkpoint flag.');
    }

    if (!baselineKey) {
      throw new Error('Missing required --key flag.');
    }

    const baselineRoot =
      configPath
        ? (await loadConfig(configPath, { cwd: repoRoot })).baselineRoot
        : DEFAULT_BASELINE_ROOT;

    const artifactStore = new ArtifactStore({
      repoRoot,
    });
    const sessionManager = new SessionManager({
      repoRoot,
      artifactStore,
    });
    const sessionState = await sessionManager.read(sessionId);

    const result = await recordBaseline({
      repoRoot,
      artifactRoot: sessionState.artifactRoot,
      baselineRoot,
      checkpointId,
      baselineKey,
      sessionId: sessionState.sessionId,
      runId: sessionState.runId,
      deterministic: sessionState.deterministic,
    });
    const payload = createSuccessEnvelope({
      baselineKey: result.baselineKey,
      registryPath: result.registryPath,
      sourceCheckpointId: result.sourceCheckpointId,
    }, result.warnings);

    await writeToStream(
      process.stdout,
      json ? `${JSON.stringify(payload, null, 2)}\n` : `${result.baselineKey}\n`,
    );
    process.exit(0);
  }

  if (args[0] === 'baseline' && args[1] === 'compare') {
    const sessionId = getFlagValue(args, '--session');
    const checkpointId = getFlagValue(args, '--checkpoint');
    const baselineKey = getFlagValue(args, '--key');
    const configPath = getFlagValue(args, '--config');
    const json = args.includes('--json');

    if (!sessionId) {
      throw new Error('Missing required --session flag.');
    }

    if (!checkpointId) {
      throw new Error('Missing required --checkpoint flag.');
    }

    if (!baselineKey) {
      throw new Error('Missing required --key flag.');
    }

    const baselineRoot =
      configPath
        ? (await loadConfig(configPath, { cwd: repoRoot })).baselineRoot
        : DEFAULT_BASELINE_ROOT;

    const artifactStore = new ArtifactStore({
      repoRoot,
    });
    const sessionManager = new SessionManager({
      repoRoot,
      artifactStore,
    });
    const sessionState = await sessionManager.read(sessionId);

    const result = await compareBaseline({
      repoRoot,
      artifactRoot: sessionState.artifactRoot,
      baselineRoot,
      checkpointId,
      baselineKey,
      runId: sessionState.runId,
    });
    const payload = createSuccessEnvelope({
      baselineKey: result.baselineKey,
      status: result.status,
      pixelDiffPercent: result.pixelDiffPercent,
      findings: result.findings,
    });

    await writeToStream(
      process.stdout,
      json ? `${JSON.stringify(payload, null, 2)}\n` : `${result.status}\n`,
    );
    process.exit(0);
  }

  if (args[0] !== 'session' || args[1] !== 'start') {
    throw new Error('Supported commands in this phase are "session start", "page find", "page act", "checkpoint create", "audit design", "baseline record", "baseline compare", and "report export".');
  }

  const configPath = getFlagValue(args, '--config');
  const mode = getFlagValue(args, '--mode') ?? 'debug';
  const browser = getFlagValue(args, '--browser') ?? 'chromium';
  const json = args.includes('--json');

  if (!configPath) {
    throw new Error('Missing required --config flag.');
  }

  const config = await loadConfig(configPath, { cwd: repoRoot });
  const devServer = config.devServers.web ?? Object.values(config.devServers)[0];

  if (!devServer) {
    throw new Error('No dev server found in probefn config.');
  }

  const sessionId = `sess_${Date.now()}`;
  const runId = `run_${Date.now()}`;
  const artifactStore = new ArtifactStore({
    repoRoot,
    artifactRoot: config.artifactRoot,
  });
  const manager = new DevServerManager({
    repoRoot,
    artifactStore,
  });

  const startedSession = await manager.startSession({
    sessionId,
    runId,
    mode: mode as 'debug' | 'design-review' | 'visual-regression' | 'mixed',
    browser: browser as 'chromium' | 'firefox' | 'webkit',
    deterministic: config.deterministicDefaults,
    devServer,
  });

  await manager.stopSession(sessionId);

  const payload = createSuccessEnvelope({
    sessionId: startedSession.sessionId,
    runId: startedSession.runId,
    artifactRoot: startedSession.artifactRoot,
    startedAt: startedSession.startedAt,
    resolvedUrl: startedSession.resolvedUrl,
  });

  if (json) {
    await writeToStream(process.stdout, `${JSON.stringify(payload, null, 2)}\n`);
  } else {
    await writeToStream(
      process.stdout,
      `session=${payload.data.sessionId} run=${payload.data.runId} url=${payload.data.resolvedUrl}\n`,
    );
  }

  process.exit(0);
}

async function readJson<T>(
  repoRoot: string,
  relativePath: string,
): Promise<T> {
  return JSON.parse(
    await readFile(path.resolve(repoRoot, relativePath), 'utf8'),
  ) as T;
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function writeToStream(
  stream: NodeJS.WriteStream,
  value: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(value, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

main().catch((error) => {
  void writeToStream(process.stderr, `${JSON.stringify(toErrorEnvelope(error), null, 2)}\n`)
    .catch(() => undefined)
    .finally(() => {
      process.exit(1);
    });
});
