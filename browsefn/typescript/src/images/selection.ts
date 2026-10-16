import { BrowseFnError } from '../core/errors.js';
import type { ImageDownloadOptions, ImageResult } from '../core/types.js';

/** Bounded lookup for URL-only consumers of search results. */
export class ImageSelection {
  private results = new Map<string, ImageResult>();
  remember(images: ImageResult[]): void {
    for (const image of images) for (const url of [image.url, image.source.url, ...Object.values(image.downloads ?? {})]) {
      if (!url) continue;
      this.results.delete(url);
      this.results.set(url, image);
      while (this.results.size > 1000) this.results.delete(this.results.keys().next().value!);
    }
  }
  resolve(input: string | ImageResult, options: ImageDownloadOptions): { url: string; options: ImageDownloadOptions } {
    const image = typeof input === 'string' ? this.results.get(input) : input;
    const selected = options.size && image?.downloads?.[options.size];
    if (image && options.size && !selected) throw new BrowseFnError({ code: 'INVALID_ARGUMENT', message: `Provider result has no ${options.size} download URL.` });
    return { url: selected || (typeof input === 'string' ? input : input.url), options: selected ? { ...options, size: undefined } : options };
  }
}
