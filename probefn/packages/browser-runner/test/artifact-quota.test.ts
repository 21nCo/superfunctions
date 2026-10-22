import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { ArtifactStore } from '@probefn/storage';
import { startTracing, stopTracing } from '../src/trace.js';
import { finalizePageVideo } from '../src/video.js';

it.each([10, 1024 * 1024])('admits real screenshot, video and trace under one retained run cap (%s)', async cap => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'probe-browser-quota-'));
  const scratch = await mkdtemp(path.join(tmpdir(), 'probe-browser-quota-video-'));
  const browser = await chromium.launch({ headless: true });
  const artifactStore = new ArtifactStore({ repoRoot, caps: { maxArtifactBytes: cap } });
  try {
    const context = await browser.newContext({ viewport: { width: 320, height: 240 }, recordVideo: { dir: scratch } });
    const options = { repoRoot, artifactStore, runId: 'browser', enabled: true };
    await startTracing(context, options);
    const page = await context.newPage();
    await page.setContent('<body style="background: #aaddff"><h1>Owned quota fixture</h1></body>');
    await page.waitForTimeout(200);
    const screenshot = await page.screenshot();
    const video = await finalizePageVideo(page);
    expect(screenshot.byteLength).toBeGreaterThan(10); expect(video.byteLength).toBeGreaterThan(10);
    const paths = artifactStore.getCheckpointPaths('browser', 'capture');
    if (cap === 10) {
      await expect(artifactStore.writeArtifact(paths.screenshotPath, screenshot)).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
      await expect(artifactStore.writeArtifact(paths.videoPath, video)).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
      await expect(stopTracing(context, options)).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
      for (const relative of [paths.screenshotPath, paths.videoPath, artifactStore.getRunPaths('browser').tracePath]) await expect(stat(path.join(repoRoot, relative))).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      await artifactStore.writeArtifact(paths.screenshotPath, screenshot);
      await artifactStore.writeArtifact(paths.videoPath, video);
      const trace = await stopTracing(context, options);
      const bytes = (await Promise.all([paths.screenshotPath, paths.videoPath, trace!].map(relative => stat(path.join(repoRoot, relative))))).reduce((sum, file) => sum + file.size, 0);
      expect(bytes).toBeLessThanOrEqual(cap);
      await expect(new ArtifactStore({ repoRoot }).writeArtifact(paths.domPath, Buffer.alloc(cap - bytes + 1))).rejects.toMatchObject({ code: 'E_STORAGE_CAP_EXCEEDED' });
    }
    expect(await readdir(path.join(repoRoot, artifactStore.getRunPaths('browser').runRoot, '.probefn-staging'))).toEqual([]);
    await context.close();
  } finally {
    await browser.close();
    await rm(scratch, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  }
}, 30_000);
