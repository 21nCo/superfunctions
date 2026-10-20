import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';

/** Finalize this playback page only, after all page-dependent snapshots. */
export async function finalizePageVideo(page: Page): Promise<Uint8Array> {
  const video = page.video();
  if (!video) throw new Error('Video recording was not enabled for this playback');
  const directory = await mkdtemp(path.join(tmpdir(), 'probefn-video-save-'));
  try {
    await page.close();
    const filename = path.join(directory, 'video.webm');
    await video.saveAs(filename);
    const bytes = await readFile(filename);
    if (bytes.length === 0) throw new Error('Recorded video is empty');
    return bytes;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
