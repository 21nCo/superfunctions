import sharp from 'sharp';
import { SHARP_INPUT_OPTIONS, assertRasterImage } from '../content-sniff.js';
import { createWorker, PSM } from 'tesseract.js';

import type { OCRProcessorProvider, OCRProviderRequest, OCRProviderResult } from '../types.js';

async function preprocessImage(imageData: Buffer): Promise<Buffer> {
  return await sharp(imageData, SHARP_INPUT_OPTIONS)
    .grayscale()
    .normalize()
    .sharpen()
    .png()
    .toBuffer();
}

export function createTesseractJsOCRProvider(): OCRProcessorProvider {
  return {
    async recognize(request: OCRProviderRequest): Promise<OCRProviderResult> {
      // Only raster images reach sharp, whatever the declared type. A private
      // copy is checked and decoded, so the caller can't change it in between.
      const imageData = Buffer.from(request.imageData);
      assertRasterImage(imageData);
      const worker = await createWorker(request.language, 1, {
        logger: () => {},
      });

      try {
        const normalized = await preprocessImage(imageData);
        await worker.setParameters({
          tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
          preserve_interword_spaces: '1',
        });

        const result = await worker.recognize(
          normalized,
          {},
          request.includeHOCR ? { hocr: true } : undefined,
        );

        return {
          text: result.data.text.trim(),
          confidence: result.data.confidence,
          hocr: result.data.hocr,
        };
      } finally {
        await worker.terminate();
      }
    },
  };
}
