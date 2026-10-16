import sharp from 'sharp';
import { open } from 'node:fs/promises';
import { BrowseFnError } from '../core/errors.js';
import type { ImageDownloadOptions, ImageMetadata } from '../core/types.js';
import { fetchImageBytes } from './download.js';

const PIXEL_LIMIT = 40_000_000;
const SIZE_BOUNDS = { small: 640, medium: 1280, large: 2048 };
const invalid = (message: string) => new BrowseFnError({ code: 'INVALID_ARGUMENT', message });
const decode = (bytes: Uint8Array) => sharp(bytes, { limitInputPixels: PIXEL_LIMIT, failOn: 'warning' });

async function watermarkBytes(input: string, options: ImageDownloadOptions): Promise<Uint8Array> {
  if (/^https?:\/\//i.test(input)) return fetchImageBytes(input, { ...options, onProgress: undefined });
  if (/^[a-z][a-z\d+.-]*:/i.test(input)) throw invalid('Watermark image must be a local file path or HTTP(S) URL.');
  const file = await open(input, 'r');
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > (options.maxPayloadBytes ?? 20 * 1024 * 1024)) throw invalid('Watermark image exceeds the configured maximum size.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally { await file.close(); }
}

export async function transformImage(input: Uint8Array, options: ImageDownloadOptions): Promise<{ bytes: Uint8Array; metadata: ImageMetadata }> {
  try {
    const source = await decode(input).metadata();
    if (!['jpeg', 'png', 'webp'].includes(source.format ?? '') || (source.pages ?? 1) > 1) throw invalid('Only static JPEG, PNG and WebP images are supported.');
    const hasTransform = ['format', 'quality', 'maxWidth', 'maxHeight', 'crop', 'watermark'].some(key => options[key as keyof ImageDownloadOptions] !== undefined) || (options.size !== undefined && options.size !== 'original');
    if (!hasTransform) {
      // Decode once to reject truncated/corrupt payloads before publishing original bytes.
      await decode(input).raw().toBuffer();
      return { bytes: input, metadata: { format: source.format!, width: source.width!, height: source.height!, size: input.length, colorSpace: source.space, hasAlpha: source.hasAlpha } };
    }
    // Normalize orientation first; crop coordinates refer to the displayed image.
    const oriented = await decode(input).rotate().png().toBuffer();
    let pipeline = decode(oriented);
    const dimensions = await pipeline.metadata();
    if (options.crop) {
      const { x, y, width, height } = options.crop;
      if (x + width > dimensions.width! || y + height > dimensions.height!) throw invalid('Crop rectangle exceeds image dimensions.');
      pipeline = pipeline.extract({ left: x, top: y, width, height });
    }
    const preset = options.size && options.size !== 'original' ? SIZE_BOUNDS[options.size] : undefined;
    const width = options.maxWidth ?? preset;
    const height = options.maxHeight ?? preset;
    if (width || height) pipeline = pipeline.resize(width, height, { fit: 'inside', withoutEnlargement: true });
    const base = await pipeline.png().toBuffer({ resolveWithObject: true });
    pipeline = decode(base.data);
    const watermark = options.watermark;
    if (watermark) {
      const layers: Parameters<ReturnType<typeof sharp>['composite']>[0] = [];
      const inputs: Uint8Array[] = [];
      if (watermark.image) inputs.push(await watermarkBytes(watermark.image, options));
      if (watermark.text) {
        const escaped = watermark.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        inputs.push(await sharp({ text: { text: `<span foreground="white">${escaped}</span>`, font: 'sans 24', rgba: true, width: Math.max(1, base.info.width), wrap: 'word' } }).png().toBuffer());
      }
      for (const bytes of inputs) {
        const info = await decode(bytes).metadata();
        if (!['jpeg', 'png', 'webp'].includes(info.format ?? '') || (info.pages ?? 1) > 1) throw invalid('Watermark must be a static JPEG, PNG or WebP image.');
        const overlay = await decode(bytes).rotate().resize(base.info.width, base.info.height, { fit: 'inside', withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        for (let index = 3; index < overlay.data.length; index += 4) overlay.data[index] = Math.round(overlay.data[index] * (watermark.opacity ?? 0.5));
        const position = watermark.position ?? 'bottom-right';
        const left = position.includes('left') ? 0 : position.includes('right') ? base.info.width - overlay.info.width : Math.floor((base.info.width - overlay.info.width) / 2);
        const top = position.includes('top') ? 0 : position.includes('bottom') ? base.info.height - overlay.info.height : Math.floor((base.info.height - overlay.info.height) / 2);
        layers.push({ input: overlay.data, raw: { width: overlay.info.width, height: overlay.info.height, channels: 4 }, left, top });
      }
      pipeline = pipeline.composite(layers);
    }
    const format = options.format ?? source.format as 'jpeg' | 'png' | 'webp';
    const quality = Math.max(1, Math.round(options.quality ?? 80));
    if (format === 'jpeg') pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality });
    else if (format === 'webp') pipeline = pipeline.webp({ quality });
    else pipeline = options.quality === undefined ? pipeline.png() : pipeline.png({ palette: true, quality });
    const output = await pipeline.toBuffer({ resolveWithObject: true });
    if (output.data.length > (options.maxPayloadBytes ?? 20 * 1024 * 1024)) throw new BrowseFnError({ code: 'DOWNLOAD_TOO_LARGE', message: 'Transformed image exceeds the configured maximum size.' });
    return { bytes: output.data, metadata: { format, width: output.info.width, height: output.info.height, size: output.data.length, hasAlpha: format !== 'jpeg' && output.info.channels === 4 } };
  } catch (error) {
    if (error instanceof BrowseFnError) throw error;
    throw invalid(`Image processing failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
