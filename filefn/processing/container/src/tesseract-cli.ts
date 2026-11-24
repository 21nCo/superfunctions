import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTENT_TYPE_MISMATCH_ERROR, SHARP_INPUT_OPTIONS, isRasterImageBytes, type OCRProcessorProvider, type OCRProviderRequest, type OCRProviderResult } from '@filefn/processing';
import sharp from 'sharp';

export interface TesseractCliOptions {
  /** The `tesseract` executable; defaults to `tesseract` on PATH. */
  binary?: string;
  /** Kills a recognition that runs longer; defaults to 120 seconds. */
  timeoutMs?: number;
}

function run(binary: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`tesseract failed: ${String(stderr).trim() || error.message}`));
      else resolve();
    });
  });
}

/** Mean confidence (0-100) of the recognized words in tesseract's TSV output; 0 when there are none. */
export function meanWordConfidence(tsv: string): number {
  const confidences = tsv
    .split('\n')
    .slice(1)
    .map((line) => line.split('\t'))
    .filter((cells) => cells.length >= 12 && cells[0] === '5' && cells[11].trim().length > 0)
    .map((cells) => Number(cells[10]))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (confidences.length === 0) return 0;
  return confidences.reduce((sum, value) => sum + value, 0) / confidences.length;
}

/**
 * OCR through the image's native `tesseract` command, with the language data
 * installed in the image, so recognition needs no network access. The image is
 * normalized with sharp as the tesseract.js provider does.
 */
export function createTesseractCliOCRProvider(options: TesseractCliOptions = {}): OCRProcessorProvider {
  const binary = options.binary ?? 'tesseract';
  const timeoutMs = options.timeoutMs ?? 120_000;

  return {
    async recognize(request: OCRProviderRequest): Promise<OCRProviderResult> {
      // Only raster images reach sharp, whatever the declared type. A private
      // copy is checked and decoded, so the caller can't change it in between.
      const imageData = Buffer.from(request.imageData);
      if (!isRasterImageBytes(imageData)) throw new Error(CONTENT_TYPE_MISMATCH_ERROR);
      const directory = await mkdtemp(join(tmpdir(), 'filefn-ocr-'));
      try {
        const input = join(directory, 'input.png');
        const output = join(directory, 'output');
        await writeFile(input, await sharp(imageData, SHARP_INPUT_OPTIONS).grayscale().normalize().sharpen().png().toBuffer());
        const formats = request.includeHOCR ? ['txt', 'tsv', 'hocr'] : ['txt', 'tsv'];
        await run(binary, [input, output, '-l', request.language, '--psm', '6', '-c', 'preserve_interword_spaces=1', ...formats], timeoutMs);
        const [text, tsv, hocr] = await Promise.all([
          readFile(`${output}.txt`, 'utf8'),
          readFile(`${output}.tsv`, 'utf8'),
          request.includeHOCR ? readFile(`${output}.hocr`, 'utf8') : Promise.resolve(null),
        ]);
        return { text: text.trim(), confidence: meanWordConfidence(tsv), hocr };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
