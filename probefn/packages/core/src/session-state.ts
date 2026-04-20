import type { BrowserEngine, DeterministicSettings, SessionMode } from '@probefn/contracts/config';
import { SCHEMA_VERSION, type SchemaVersion } from '@probefn/contracts/envelopes';

export type SessionLifecycleStatus = 'starting' | 'running' | 'completed' | 'failed';

export interface SessionArtifactsState {
  manifestPath: string;
  tracePath?: string | null;
  storageStatePath?: string;
  reportJsonPath?: string;
  reportMarkdownPath?: string;
  consoleSinkPath?: string;
  pageErrorSinkPath?: string;
  networkSinkPath?: string;
  devServerStdoutSinkPath?: string;
  devServerStderrSinkPath?: string;
}

export interface SessionState {
  schemaVersion: SchemaVersion;
  sessionId: string;
  runId: string;
  mode: SessionMode;
  browser: BrowserEngine;
  artifactRoot: string;
  startedAt: string;
  endedAt?: string;
  status: SessionLifecycleStatus;
  deterministic: DeterministicSettings;
  resolvedUrl?: string;
  artifacts: SessionArtifactsState;
}

export function createSessionState(
  input: Omit<SessionState, 'schemaVersion'>,
): SessionState {
  return {
    schemaVersion: SCHEMA_VERSION,
    ...input,
  };
}
