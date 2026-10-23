import { PNG } from 'pngjs';

import { createProbefnError } from '@probefn/contracts';

export interface PixelDiffResult {
  pixelDiffPercent: number;
  changedPixels: number;
  totalPixels: number;
  diffPng: Buffer;
}

export function diffScreenshots(
  baselineBuffer: Buffer,
  currentBuffer: Buffer,
): PixelDiffResult {
  const baseline = PNG.sync.read(baselineBuffer);
  const current = PNG.sync.read(currentBuffer);

  if (baseline.width !== current.width || baseline.height !== current.height) {
    throw createProbefnError({
      code: 'E_BASELINE_MISMATCH',
      message: 'Baseline dimensions do not match the checkpoint dimensions.',
      retryable: false,
      details: {
        baseline: `${baseline.width}x${baseline.height}`,
        current: `${current.width}x${current.height}`,
      },
    });
  }

  const diff = new PNG({
    width: baseline.width,
    height: baseline.height,
  });

  let changedPixels = 0;
  for (let index = 0; index < baseline.data.length; index += 4) {
    const baselineRed = baseline.data[index] ?? 0;
    const baselineGreen = baseline.data[index + 1] ?? 0;
    const baselineBlue = baseline.data[index + 2] ?? 0;
    const baselineAlpha = baseline.data[index + 3] ?? 0;
    const currentRed = current.data[index] ?? 0;
    const currentGreen = current.data[index + 1] ?? 0;
    const currentBlue = current.data[index + 2] ?? 0;
    const currentAlpha = current.data[index + 3] ?? 0;

    const changed =
      baselineRed !== currentRed ||
      baselineGreen !== currentGreen ||
      baselineBlue !== currentBlue ||
      baselineAlpha !== currentAlpha;

    if (changed) {
      changedPixels += 1;
      diff.data[index] = 255;
      diff.data[index + 1] = 0;
      diff.data[index + 2] = 0;
      diff.data[index + 3] = 255;
      continue;
    }

    const grayscale = Math.round(
      baselineRed * 0.3 + baselineGreen * 0.59 + baselineBlue * 0.11,
    );
    diff.data[index] = grayscale;
    diff.data[index + 1] = grayscale;
    diff.data[index + 2] = grayscale;
    diff.data[index + 3] = 255;
  }

  const totalPixels = baseline.width * baseline.height;
  return {
    pixelDiffPercent: Number(((changedPixels / Math.max(totalPixels, 1)) * 100).toFixed(1)),
    changedPixels,
    totalPixels,
    diffPng: PNG.sync.write(diff),
  };
}
