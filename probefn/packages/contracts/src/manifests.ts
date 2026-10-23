import type { BrowserEngine, DeterministicSettings, SessionMode } from './config.js';
import { SCHEMA_VERSION, type SchemaVersion } from './envelopes.js';

export { SCHEMA_VERSION };

export interface RunManifest {
  schemaVersion: SchemaVersion;
  sessionId: string;
  runId: string;
  mode: SessionMode;
  browser: BrowserEngine;
  artifactRoot: string;
  startedAt: string;
  endedAt?: string;
  status: 'running' | 'completed' | 'failed';
  deterministic: DeterministicSettings;
  unstable?: boolean;
  devServer?: {
    mode: 'attach' | 'spawn';
    name: string;
    url: string;
    resolvedUrl?: string;
    readyPattern?: string;
    pid?: number;
  };
}

export interface CheckpointArtifact {
  kind: 'screenshot' | 'dom' | 'ax' | 'layout' | 'styles' | 'trace' | 'video';
  path: string;
  sha256: string;
}

export interface CheckpointManifest {
  schemaVersion: SchemaVersion;
  checkpointId: string;
  sessionId: string;
  runId: string;
  browser: BrowserEngine;
  name: string;
  url: string;
  viewport: {
    width: number;
    height: number;
  };
  unstable?: boolean;
  artifacts: CheckpointArtifact[];
  createdAt: string;
}

export function createRunManifest(
  input: Omit<RunManifest, 'schemaVersion'>,
): RunManifest {
  return {
    schemaVersion: SCHEMA_VERSION,
    ...input,
  };
}
