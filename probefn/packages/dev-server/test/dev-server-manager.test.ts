import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { DeterministicSettings } from '@probefn/contracts/config';
import { isProbefnError } from '@probefn/contracts/errors';
import { ArtifactStore } from '@probefn/storage';

import { DevServerManager } from '../src/dev-server-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../..');

const tempDirectories: string[] = [];
const attachedServers: Server[] = [];

const deterministic: DeterministicSettings = {
  enabled: true,
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
  timezone: 'UTC',
  colorScheme: 'light',
  reducedMotion: 'reduce',
  animationPolicy: 'freeze',
  networkIdleMs: 500,
};

async function createArtifactLocation(): Promise<{ repoRoot: string; artifactRoot: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'probefn-dev-server-'));
  tempDirectories.push(directory);
  return {
    repoRoot: projectRoot,
    artifactRoot: `.artifacts-tests/${path.basename(directory)}`,
  };
}

afterEach(async () => {
  await Promise.all(
    attachedServers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
  await Promise.all(
    tempDirectories.splice(0).map(async (directory) => {
      await rm(path.resolve(projectRoot, '.artifacts-tests', path.basename(directory)), {
        recursive: true,
        force: true,
      });
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('DevServerManager', () => {
  it('starts a spawned dev server, writes sinks, and finalizes the session', async () => {
    const { repoRoot, artifactRoot } = await createArtifactLocation();
    const artifactStore = new ArtifactStore({ repoRoot, artifactRoot });
    const manager = new DevServerManager({ repoRoot, artifactStore });

    const startedSession = await manager.startSession({
      sessionId: 'sess_healthy',
      runId: 'run_healthy',
      mode: 'mixed',
      browser: 'chromium',
      deterministic,
      devServer: {
        mode: 'spawn',
        name: 'web',
        command: `${process.execPath} test/fixtures/vite-healthy/server.mjs --port 4173 --emit-hmr`,
        cwd: '.',
        url: 'http://127.0.0.1:4173',
        readyPattern: 'Local:\\s+(https?:\\/\\/[^\\s]+)',
        timeoutMs: 5000,
        envAllowlist: [],
      },
    });

    expect(startedSession.resolvedUrl).toBe('http://127.0.0.1:4173/');
    expect(startedSession.stdoutSinkPath).toBe(
      `${artifactRoot}/runs/run_healthy/devserver/stdout.ndjson`,
    );
    expect(startedSession.stderrSinkPath).toBe(
      `${artifactRoot}/runs/run_healthy/devserver/stderr.ndjson`,
    );

    await new Promise((resolve) => setTimeout(resolve, 250));
    await manager.stopSession('sess_healthy');

    const manifestContents = JSON.parse(
      await readFile(path.resolve(repoRoot, artifactRoot, 'runs/run_healthy/session.json'), 'utf8'),
    );
    const stdoutSinkContents = await readFile(
      path.resolve(repoRoot, artifactRoot, 'runs/run_healthy/devserver/stdout.ndjson'),
      'utf8',
    );
    const stdoutEvents = stdoutSinkContents
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { line: string; stream: string; source: string; ts: string });

    expect(startedSession).toMatchObject({
      sessionId: 'sess_healthy',
      runId: 'run_healthy',
      artifactRoot: `${artifactRoot}/runs/run_healthy`,
      manifestPath: `${artifactRoot}/runs/run_healthy/session.json`,
      resolvedUrl: 'http://127.0.0.1:4173/',
      stdoutSinkPath: `${artifactRoot}/runs/run_healthy/devserver/stdout.ndjson`,
      stderrSinkPath: `${artifactRoot}/runs/run_healthy/devserver/stderr.ndjson`,
    });
    expect(manifestContents).toMatchObject({
      sessionId: 'sess_healthy',
      runId: 'run_healthy',
      artifactRoot: `${artifactRoot}/runs/run_healthy`,
      status: 'completed',
      unstable: true,
      devServer: {
        mode: 'spawn',
        name: 'web',
        url: 'http://127.0.0.1:4173',
        resolvedUrl: 'http://127.0.0.1:4173/',
        readyPattern: 'Local:\\s+(https?:\\/\\/[^\\s]+)',
      },
    });
    expect(manifestContents.startedAt).toEqual(expect.any(String));
    expect(manifestContents.endedAt).toEqual(expect.any(String));
    expect(stdoutEvents).toHaveLength(3);
    expect(stdoutEvents.map((event) => event.stream)).toEqual(['stdout', 'stdout', 'stdout']);
    expect(stdoutEvents.map((event) => event.source)).toEqual(['dev-server', 'dev-server', 'dev-server']);
    expect(stdoutEvents.map((event) => event.line).sort()).toEqual([
      '  VITE v5.0.0  ready in 12 ms',
      '  ➜  Local:   http://127.0.0.1:4173/',
      'hmr update /src/main.tsx',
    ]);
  });

  it('times out when a spawned server never reaches readiness', async () => {
    const { repoRoot, artifactRoot } = await createArtifactLocation();
    const artifactStore = new ArtifactStore({ repoRoot, artifactRoot });
    const manager = new DevServerManager({ repoRoot, artifactStore });

    try {
      await manager.startSession({
        sessionId: 'sess_hangs',
        runId: 'run_hangs',
        mode: 'mixed',
        browser: 'chromium',
        deterministic,
        devServer: {
          mode: 'spawn',
          name: 'web',
          command: `${process.execPath} test/fixtures/vite-hangs/server.mjs`,
          cwd: '.',
          url: 'http://127.0.0.1:4174',
          readyPattern: 'Local:\\s+(https?:\\/\\/[^\\s]+)',
          timeoutMs: 300,
          envAllowlist: [],
        },
      });

      throw new Error('Expected timeout session start to fail.');
    } catch (error) {
      expect(isProbefnError(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'E_DEVSERVER_START_TIMEOUT',
        message: 'Dev server did not become ready within 300ms.',
      });

      const manifestContents = JSON.parse(
        await readFile(path.resolve(repoRoot, artifactRoot, 'runs/run_hangs/session.json'), 'utf8'),
      );
      expect(manifestContents.status).toBe('failed');
      expect(manifestContents.endedAt).toBeDefined();
    }
  });

  it('attaches to an already running server and rejects duplicate active sessions', async () => {
    const { repoRoot, artifactRoot } = await createArtifactLocation();
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.end('ok');
    });

    await new Promise<void>((resolve) => server.listen(4175, '127.0.0.1', resolve));
    attachedServers.push(server);

    const artifactStore = new ArtifactStore({ repoRoot, artifactRoot });
    const manager = new DevServerManager({ repoRoot, artifactStore });

    const startedSession = await manager.startSession({
      sessionId: 'sess_attach',
      runId: 'run_attach',
      mode: 'debug',
      browser: 'chromium',
      deterministic,
      devServer: {
        mode: 'attach',
        name: 'web',
        url: 'http://127.0.0.1:4175',
        timeoutMs: 1000,
        envAllowlist: [],
      },
    });

    expect(startedSession.resolvedUrl).toBe('http://127.0.0.1:4175');

    await expect(
      manager.startSession({
        sessionId: 'sess_attach',
        runId: 'run_attach_again',
        mode: 'debug',
        browser: 'chromium',
        deterministic,
        devServer: {
          mode: 'attach',
          name: 'web',
          url: 'http://127.0.0.1:4175',
          timeoutMs: 1000,
          envAllowlist: [],
        },
      }),
    ).rejects.toMatchObject({
      code: 'E_SESSION_ALREADY_RUNNING',
    });

    await manager.stopSession('sess_attach');
    const manifestContents = JSON.parse(
      await readFile(path.resolve(repoRoot, artifactRoot, 'runs/run_attach/session.json'), 'utf8'),
    );
    expect(manifestContents.status).toBe('completed');
    expect(manifestContents.endedAt).toBeDefined();
  });

  it('rejects unreachable attached servers', async () => {
    const { repoRoot, artifactRoot } = await createArtifactLocation();
    const artifactStore = new ArtifactStore({ repoRoot, artifactRoot });
    const manager = new DevServerManager({ repoRoot, artifactStore });

    await expect(
      manager.startSession({
        sessionId: 'sess_unreachable',
        runId: 'run_unreachable',
        mode: 'debug',
        browser: 'chromium',
        deterministic,
        devServer: {
          mode: 'attach',
          name: 'web',
          url: 'http://127.0.0.1:4999',
          timeoutMs: 250,
          envAllowlist: [],
        },
      }),
    ).rejects.toMatchObject({
      code: 'E_URL_UNREACHABLE',
      message: 'Could not reach http://127.0.0.1:4999 before session start.',
    });
  });
});
