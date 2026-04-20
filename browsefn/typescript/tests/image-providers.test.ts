import { afterEach, describe, expect, it, vi } from 'vitest';

import { ImageBrowser } from '../src/images/browser.js';
import { PexelsProvider } from '../src/images/providers/pexels.js';
import { PixabayProvider } from '../src/images/providers/pixabay.js';
import { UnsplashProvider } from '../src/images/providers/unsplash.js';

describe('Image providers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes Unsplash search results through the image browser contract', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        total: 35,
        results: [
          {
            id: 'photo-1',
            width: 1920,
            height: 1080,
            description: 'Mountain',
            alt_description: 'Mountain landscape',
            urls: {
              thumb: 'https://images.example.com/thumb.jpg',
              small: 'https://images.example.com/small.jpg',
              regular: 'https://images.example.com/regular.jpg',
              full: 'https://images.example.com/full.jpg',
              raw: 'https://images.example.com/raw.jpg',
            },
            user: {
              name: 'Alex',
              links: { html: 'https://unsplash.com/@alex' },
            },
            links: { html: 'https://unsplash.com/photos/photo-1' },
            tags: [{ title: 'mountain' }],
          },
        ],
      }),
    } as Response);

    const browser = new ImageBrowser(undefined, undefined, 'unsplash');
    browser.registerProvider(new UnsplashProvider({ apiKey: 'unsplash-key' }));

    const result = await browser.search('mountain landscape', {
      provider: 'unsplash',
      perPage: 20,
      orientation: 'landscape',
      filters: {
        minWidth: 1920,
        safeSearch: true,
      },
    });

    expect(result).toMatchObject({
      query: 'mountain landscape',
      provider: 'unsplash',
      page: 1,
      perPage: 20,
    });
    expect(result.results[0].source.provider).toBe('unsplash');
  });

  it('maps Pixabay pagination and provider ids canonically', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        totalHits: 45,
        hits: [
          {
            id: 7,
            largeImageURL: 'https://pixabay.example.com/large.jpg',
            previewURL: 'https://pixabay.example.com/preview.jpg',
            imageWidth: 1200,
            imageHeight: 800,
            tags: 'forest, trees',
            user: 'Sam',
            user_id: 10,
            pageURL: 'https://pixabay.com/photos/7',
            webformatURL: 'https://pixabay.example.com/web.jpg',
          },
        ],
      }),
    } as Response);

    const result = await new PixabayProvider({ apiKey: 'pixabay-key' }).search('forest', {
      page: 2,
      perPage: 20,
      filters: { safeSearch: true },
    });

    expect(result.provider).toBe('pixabay');
    expect(result.page).toBe(2);
    expect(result.perPage).toBe(20);
    expect(result.nextPage).toBe(3);
    expect(result.results[0].source.provider).toBe('pixabay');
  });

  it('maps Pexels pagination and provider ids canonically', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        total_results: 30,
        next_page: 'https://api.pexels.com/v1/search?page=2',
        photos: [
          {
            id: 11,
            width: 1024,
            height: 768,
            alt: 'Sunrise',
            photographer: 'Riley',
            photographer_url: 'https://pexels.com/@riley',
            url: 'https://pexels.com/photo/11',
            src: {
              tiny: 'https://pexels.example.com/tiny.jpg',
              small: 'https://pexels.example.com/small.jpg',
              medium: 'https://pexels.example.com/medium.jpg',
              large: 'https://pexels.example.com/large.jpg',
              original: 'https://pexels.example.com/original.jpg',
            },
          },
        ],
      }),
    } as Response);

    const result = await new PexelsProvider({ apiKey: 'pexels-key' }).search('sunrise', {
      page: 1,
      perPage: 20,
      orientation: 'landscape',
    });

    expect(result.provider).toBe('pexels');
    expect(result.page).toBe(1);
    expect(result.perPage).toBe(20);
    expect(result.nextPage).toBe(2);
    expect(result.results[0].source.provider).toBe('pexels');
  });

  it('rejects invalid image-search filters with canonical validation errors', async () => {
    const browser = new ImageBrowser();

    await expect(
      browser.search('mountain landscape', {
        provider: 'unsplash',
        perPage: 0,
      })
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: 'perPage must be between 1 and 100.',
    });
  });
});
