import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from '@probefn/storage';
import { createCheckpoint } from '@probefn/core';
import { BrowserRunner } from '../src/browser-runner.js';
import { finalizePageVideo, streamPageVideo } from '../src/video.js';
const deterministic = { enabled: true, viewport: { width: 800, height: 600 }, locale: 'en-US', timezone: 'UTC', colorScheme: 'light' as const, reducedMotion: 'reduce' as const, animationPolicy: 'freeze' as const, networkIdleMs: 0 };

describe('requested checkpoint video', () => {
  it.each([{ fail: false, stream: false }, { fail: true, stream: false }, { fail: false, stream: true }, { fail: true, stream: true }])('finalizes real Chromium video before manifest commit (%j)', async ({ fail, stream }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'probefn-checkpoint-video-'));
    const store = new ArtifactStore({ repoRoot: root });
    const runner = new BrowserRunner({ repoRoot: root, artifactStore: store });
    try {
      const session = await runner.startSession({ sessionId: 'video', runId: 'video', browser: 'chromium', deterministic, trace: { enabled: false }, video: { enabled: true } });
      await session.page.setContent('<body><h1>Recorded checkpoint</h1></body>');
      await session.page.waitForTimeout(250);
      const recordingPath = await session.page.video()!.path();
      const paths = store.getCheckpointPaths('video', 'recorded');
      const commit = vi.spyOn(store, 'writeCheckpointManifest');
      const result = createCheckpoint({ repoRoot: root, artifactStore: store, sessionId: 'video', runId: 'video', browser: 'chromium', name: 'recorded', includeVideo: true,
        delta: { newConsoleErrors: 0, newPageErrors: 0, newNetworkFailures: 0 },
        source: { url: () => session.page.url(), viewportSize: () => session.page.viewportSize()!, screenshot: () => session.page.screenshot(),
          domSnapshot: () => session.page.content(), accessibilitySnapshot: () => session.page.locator('body').ariaSnapshot(), layoutSnapshot: async () => ({ width: 800 }),
          ...(stream ? { videoCaptureStream: (consume: Parameters<typeof streamPageVideo>[1]) => streamPageVideo(session.page, async video => { await consume(video); if (fail) throw new Error('Injected finalization failure'); }) } : {}),
          videoCapture: async () => { const bytes = await finalizePageVideo(session.page); if (fail) throw new Error('Injected finalization failure'); return bytes; },
        },
      });
      if (fail) {
        await expect(result).rejects.toMatchObject({ code: 'E_CHECKPOINT_CAPTURE_FAILED' });
        expect(commit).not.toHaveBeenCalled();
        for (const file of [paths.manifestPath, paths.videoPath, paths.screenshotPath, paths.domPath]) await expect(stat(path.join(root, file))).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        const checkpoint = await result;
        expect(checkpoint.artifacts).toContain(paths.videoPath);
        const video = await readFile(path.join(root, paths.videoPath));
        expect(video.length).toBeGreaterThan(100);
        const manifest = JSON.parse(await readFile(path.join(root, paths.manifestPath), 'utf8'));
        expect(manifest.artifacts.find((artifact: { kind: string }) => artifact.kind === 'video')).toEqual({ kind: 'video', path: paths.videoPath, sha256: createHash('sha256').update(video).digest('hex') });
        const decoder = await session.page.context().newPage();
        const dimensions = await decoder.evaluate(async data => {
          const video = document.createElement('video'); video.src = data;
          await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(new Error('Cannot decode recorded WebM')); });
          return [video.videoWidth, video.videoHeight];
        }, `data:video/webm;base64,${video.toString('base64')}`);
        expect(dimensions.every(value => value > 0)).toBe(true);
        expect(await session.page.context().storageState()).toHaveProperty('cookies');
      }
      await runner.stopSession('video');
      await expect(stat(path.dirname(recordingPath))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await runner.stopSession('video').catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);

  it('rejects requested video when the capture source is absent', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'probefn-video-missing-'));
    const store = new ArtifactStore({ repoRoot: root });
    try {
      await expect(createCheckpoint({ repoRoot: root, artifactStore: store, sessionId: 'missing', runId: 'missing', browser: 'chromium', name: 'missing', includeVideo: true,
        delta: { newConsoleErrors: 0, newPageErrors: 0, newNetworkFailures: 0 }, source: { url: () => 'about:blank', viewportSize: () => ({ width: 1, height: 1 }), screenshot: async () => new Uint8Array([1]), domSnapshot: async () => ({}), accessibilitySnapshot: async () => ({}), layoutSnapshot: async () => ({}) },
      })).rejects.toMatchObject({ code: 'E_CHECKPOINT_CAPTURE_FAILED' });
      await expect(stat(path.join(root, store.getCheckpointPaths('missing', 'missing').manifestPath))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
