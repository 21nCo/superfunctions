import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { BrowserEngine, DeterministicSettings, SessionMode } from '@probefn/contracts/config';
import { createProbefnError } from '@probefn/contracts/errors';
import type { ReportJsonDocument } from '@probefn/session-reporter';
import { ArtifactStore, assertArtifactIdentifier } from '@probefn/storage';

import { ReportService } from './report-service.js';
import { createSessionState, type SessionArtifactsState, type SessionLifecycleStatus, type SessionState } from './session-state.js';

export interface SessionManagerOptions {
  repoRoot: string;
  artifactStore: ArtifactStore;
  now?: () => string;
}

export interface InitializeSessionStateInput {
  sessionId: string;
  runId: string;
  mode: SessionMode;
  browser: BrowserEngine;
  deterministic: DeterministicSettings;
  artifactRoot: string;
  startedAt: string;
  manifestPath: string;
  resolvedUrl?: string;
  artifacts?: Partial<SessionArtifactsState>;
}

export interface ExportReportResult {
  reportPath: string;
  tracePath: string | null;
  redactedValueCount: number;
  warnings: string[];
  includes: string[];
  reportData: ReportJsonDocument;
}

export class SessionManager {
  private readonly repoRoot: string;
  private readonly artifactStore: ArtifactStore;
  private readonly now: () => string;

  public constructor(options: SessionManagerOptions) {
    this.repoRoot = options.repoRoot;
    this.artifactStore = options.artifactStore;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async initialize(input: InitializeSessionStateInput): Promise<SessionState> {
    assertArtifactIdentifier(input.runId, 'Run id');
    assertArtifactIdentifier(input.sessionId, 'Session id');
    const state = createSessionState({
      sessionId: input.sessionId,
      runId: input.runId,
      mode: input.mode,
      browser: input.browser,
      deterministic: input.deterministic,
      artifactRoot: input.artifactRoot,
      startedAt: input.startedAt,
      status: 'starting',
      ...(input.resolvedUrl ? { resolvedUrl: input.resolvedUrl } : {}),
      artifacts: {
        manifestPath: input.manifestPath,
        ...(input.artifacts?.tracePaths ? { tracePaths: input.artifacts.tracePaths } : {}),
        ...(input.artifacts?.tracePath !== undefined ? { tracePath: input.artifacts.tracePath } : {}),
        ...(input.artifacts?.storageStatePath ? { storageStatePath: input.artifacts.storageStatePath } : {}),
        ...(input.artifacts?.reportJsonPath ? { reportJsonPath: input.artifacts.reportJsonPath } : {}),
        ...(input.artifacts?.reportMarkdownPath ? { reportMarkdownPath: input.artifacts.reportMarkdownPath } : {}),
        ...(input.artifacts?.consoleSinkPath ? { consoleSinkPath: input.artifacts.consoleSinkPath } : {}),
        ...(input.artifacts?.pageErrorSinkPath ? { pageErrorSinkPath: input.artifacts.pageErrorSinkPath } : {}),
        ...(input.artifacts?.networkSinkPath ? { networkSinkPath: input.artifacts.networkSinkPath } : {}),
        ...(input.artifacts?.devServerStdoutSinkPath ? { devServerStdoutSinkPath: input.artifacts.devServerStdoutSinkPath } : {}),
        ...(input.artifacts?.devServerStderrSinkPath ? { devServerStderrSinkPath: input.artifacts.devServerStderrSinkPath } : {}),
      },
    });
    await this.writeState(state);
    return state;
  }

  public async read(sessionId: string): Promise<SessionState> {
    const relativePath = this.getStatePath(sessionId);
    const absolutePath = path.resolve(this.repoRoot, relativePath);

    try {
      const contents = await readFile(absolutePath, 'utf8');
      return JSON.parse(contents) as SessionState;
    } catch (error) {
      throw createProbefnError({
        code: 'E_SESSION_NOT_FOUND',
        message: `Session ${sessionId} was not found.`,
        retryable: false,
        details: {
          sessionId,
        },
        cause: error,
      });
    }
  }

  public async markRunning(
    sessionId: string,
    patch: {
      endedAt?: string;
      resolvedUrl?: string;
      artifacts?: Partial<SessionArtifactsState>;
    } = {},
  ): Promise<SessionState> {
    return this.update(sessionId, (currentState) =>
      this.withPatch(currentState, 'running', patch),
    );
  }

  public async markCompleted(
    sessionId: string,
    patch: {
      endedAt?: string;
      resolvedUrl?: string;
      artifacts?: Partial<SessionArtifactsState>;
    } = {},
  ): Promise<SessionState> {
    return this.update(sessionId, (currentState) =>
      this.withPatch(currentState, 'completed', {
        ...patch,
        endedAt: patch.endedAt ?? this.now(),
      }),
    );
  }

  public async markFailed(
    sessionId: string,
    patch: {
      endedAt?: string;
      resolvedUrl?: string;
      artifacts?: Partial<SessionArtifactsState>;
    } = {},
  ): Promise<SessionState> {
    return this.update(sessionId, (currentState) =>
      this.withPatch(currentState, 'failed', {
        ...patch,
        endedAt: patch.endedAt ?? this.now(),
      }),
    );
  }

  public async exportReport(
    input: {
      sessionId: string;
      format: 'json' | 'markdown';
    },
  ): Promise<ExportReportResult> {
    const state = await this.read(input.sessionId);
    const reportService = new ReportService({
      repoRoot: this.repoRoot,
      artifactStore: this.artifactStore,
    });
    const exportedReport = await reportService.exportReport({
      session: state,
      format: input.format,
    });

    const nextState = this.withPatch(state, state.status, {
      artifacts: {
        ...(input.format === 'json' ? { reportJsonPath: exportedReport.reportPath } : {}),
        ...(input.format === 'markdown' ? { reportMarkdownPath: exportedReport.reportPath } : {}),
      },
    });
    await this.writeState(nextState);

    return {
      ...exportedReport,
    };
  }

  public async exportReportArtifact(input: { sessionId: string; format: 'json' | 'markdown' }): Promise<Omit<ExportReportResult, 'reportData'>> {
    const state = await this.read(input.sessionId);
    const service = new ReportService({ repoRoot: this.repoRoot, artifactStore: this.artifactStore });
    const result = await service.exportReportArtifact({ session: state, format: input.format });
    await this.writeState(this.withPatch(state, state.status, { artifacts: {
      ...(input.format === 'json' ? { reportJsonPath: result.reportPath } : { reportMarkdownPath: result.reportPath }),
    } }));
    return result;
  }

  public getStatePath(sessionId: string): string {
    assertArtifactIdentifier(sessionId, 'Session id');
    return path.posix.join(this.artifactStore.getArtifactRoot(), 'session-state', `${sessionId}.json`);
  }

  private async update(
    sessionId: string,
    updater: (currentState: SessionState) => SessionState,
  ): Promise<SessionState> {
    const currentState = await this.read(sessionId);
    const nextState = updater(currentState);
    await this.writeState(nextState);
    return nextState;
  }

  private withPatch(
    currentState: SessionState,
    status: SessionLifecycleStatus,
    patch: {
      endedAt?: string;
      resolvedUrl?: string;
      artifacts?: Partial<SessionArtifactsState>;
    },
  ): SessionState {
    return createSessionState({
      sessionId: currentState.sessionId,
      runId: currentState.runId,
      mode: currentState.mode,
      browser: currentState.browser,
      deterministic: currentState.deterministic,
      artifactRoot: currentState.artifactRoot,
      startedAt: currentState.startedAt,
      status,
      ...(patch.endedAt ?? currentState.endedAt ? { endedAt: patch.endedAt ?? currentState.endedAt! } : {}),
      ...(patch.resolvedUrl ?? currentState.resolvedUrl ? { resolvedUrl: patch.resolvedUrl ?? currentState.resolvedUrl! } : {}),
      artifacts: {
        manifestPath: patch.artifacts?.manifestPath ?? currentState.artifacts.manifestPath,
        ...(patch.artifacts?.tracePaths ?? currentState.artifacts.tracePaths ? { tracePaths: patch.artifacts?.tracePaths ?? currentState.artifacts.tracePaths! } : {}),
        ...(patch.artifacts?.tracePath !== undefined || currentState.artifacts.tracePath !== undefined
          ? { tracePath: patch.artifacts?.tracePath ?? currentState.artifacts.tracePath ?? null }
          : {}),
        ...(patch.artifacts?.storageStatePath ?? currentState.artifacts.storageStatePath
          ? { storageStatePath: patch.artifacts?.storageStatePath ?? currentState.artifacts.storageStatePath! }
          : {}),
        ...(patch.artifacts?.reportJsonPath ?? currentState.artifacts.reportJsonPath
          ? { reportJsonPath: patch.artifacts?.reportJsonPath ?? currentState.artifacts.reportJsonPath! }
          : {}),
        ...(patch.artifacts?.reportMarkdownPath ?? currentState.artifacts.reportMarkdownPath
          ? { reportMarkdownPath: patch.artifacts?.reportMarkdownPath ?? currentState.artifacts.reportMarkdownPath! }
          : {}),
        ...(patch.artifacts?.consoleSinkPath ?? currentState.artifacts.consoleSinkPath
          ? { consoleSinkPath: patch.artifacts?.consoleSinkPath ?? currentState.artifacts.consoleSinkPath! }
          : {}),
        ...(patch.artifacts?.pageErrorSinkPath ?? currentState.artifacts.pageErrorSinkPath
          ? { pageErrorSinkPath: patch.artifacts?.pageErrorSinkPath ?? currentState.artifacts.pageErrorSinkPath! }
          : {}),
        ...(patch.artifacts?.networkSinkPath ?? currentState.artifacts.networkSinkPath
          ? { networkSinkPath: patch.artifacts?.networkSinkPath ?? currentState.artifacts.networkSinkPath! }
          : {}),
        ...(patch.artifacts?.devServerStdoutSinkPath ?? currentState.artifacts.devServerStdoutSinkPath
          ? { devServerStdoutSinkPath: patch.artifacts?.devServerStdoutSinkPath ?? currentState.artifacts.devServerStdoutSinkPath! }
          : {}),
        ...(patch.artifacts?.devServerStderrSinkPath ?? currentState.artifacts.devServerStderrSinkPath
          ? { devServerStderrSinkPath: patch.artifacts?.devServerStderrSinkPath ?? currentState.artifacts.devServerStderrSinkPath! }
          : {}),
      },
    });
  }

  private async writeState(state: SessionState): Promise<void> {
    const relativePath = this.getStatePath(state.sessionId);
    await this.artifactStore.writeArtifact(`${relativePath}`, `${JSON.stringify(state, null, 2)}\n`, { runId: state.runId });
  }
}
