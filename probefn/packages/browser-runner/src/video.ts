import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
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

/** Finalize and lazily stream the existing recording; its context owner retains scratch cleanup. */
export async function streamPageVideo(page: Page, consume: (video: { byteLength: number; chunks: AsyncIterable<Uint8Array> }) => Promise<void>): Promise<void> {
  const video = page.video();
  if (!video) throw new Error('Video recording was not enabled for this playback');
  await page.close();
  // path() alone does not wait for encoder completion. saveAs joins finalization
  // without buffering the recording in JavaScript; the copy shares owned scratch.
  const filename = `${await video.path()}.finalized.webm`;
  await video.saveAs(filename);
  const file = await open(filename, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size <= 0) throw new Error('Recorded video is empty or invalid');
    const chunks = (async function* () {
      for await (const chunk of file.createReadStream({ highWaterMark: 64 * 1024, autoClose: false })) yield chunk as Buffer;
    })();
    await consume({ byteLength: info.size, chunks });
  } finally { await file.close(); }
}
