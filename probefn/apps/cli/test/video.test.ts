import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ProbefnRuntime } from '@probefn/mcp-server';
import { runCheckpointCommand } from '../src/commands/checkpoint.js';

it('propagates CLI and MCP requested video through actual Chromium playback', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'probefn-video-surfaces-'));
  try {
    const runtime = new ProbefnRuntime(root);
    const scope = runtime.createScope();
    await scope.sessionManager.initialize({ sessionId: 'video', runId: 'video', mode: 'debug', browser: 'chromium', artifactRoot: scope.artifactRoot,
      deterministic: { enabled: true, viewport: { width: 800, height: 600 }, locale: 'en-US', timezone: 'UTC', colorScheme: 'light', reducedMotion: 'reduce', animationPolicy: 'freeze', networkIdleMs: 250 },
      startedAt: new Date().toISOString(), manifestPath: scope.artifactStore.getRunPaths('video').sessionManifestPath,
      resolvedUrl: 'data:text/html,<body><h1>Checkpoint video</h1></body>',
    });
    const cli = await runCheckpointCommand(['create', '--session', 'video', '--name', 'cli', '--include-video'], { repoRoot: root, runtime });
    expect(cli.envelope.ok).toBe(true);
    if (cli.envelope.ok) expect(cli.envelope.warnings).toEqual([]);
    const mcp = await runtime.callTool('probefn_checkpoint_create', { sessionId: 'video', name: 'mcp', includeVideo: true });
    expect(mcp.isError).toBe(false);
    for (const name of ['cli', 'mcp']) {
      const paths = scope.artifactStore.getCheckpointPaths('video', name);
      const manifest = JSON.parse(await readFile(path.join(root, paths.manifestPath), 'utf8'));
      expect(manifest.artifacts.some((artifact: { kind: string; path: string }) => artifact.kind === 'video' && artifact.path === paths.videoPath)).toBe(true);
      expect((await readFile(path.join(root, paths.videoPath))).length).toBeGreaterThan(100);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20000);
