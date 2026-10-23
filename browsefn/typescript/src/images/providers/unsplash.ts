/**
 * Unsplash provider for image search
 */

import type {
  ImageProvider,
  ImageSearchOptions,
  ImageSearchResult,
  ImageResult
} from '../../core/types.js';

export class UnsplashProvider implements ImageProvider {
  name = 'unsplash';

  constructor(
    private config: {
      apiKey: string;
      endpoint?: string;
    }
  ) {}

  async search(
    query: string,
    options: ImageSearchOptions = {}
  ): Promise<ImageSearchResult> {
    const endpoint = this.config.endpoint || 'https://api.unsplash.com';
    const page = options.page || 1;
    const perPage = options.perPage || 20;

    const params = new URLSearchParams({
      query,
      page: page.toString(),
      per_page: perPage.toString(),
      ...(options.orientation && { orientation: options.orientation }),
      ...(options.color && { color: options.color }),
      ...(options.orderBy && { order_by: options.orderBy })
    });

    const response = await fetch(`${endpoint}/search/photos?${params}`, {
      headers: {
        'Authorization': `Client-ID ${this.config.apiKey}`
      }
    });

    if (!response.ok) {
      throw new Error(`Unsplash API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    const results: ImageResult[] = data.results.map((photo: any) => ({
      id: photo.id,
      url: photo.urls.regular,
      thumbnail: photo.urls.thumb,
      width: photo.width,
      height: photo.height,
      description: photo.description || photo.alt_description,
      alt: photo.alt_description,
      author: {
        name: photo.user.name,
        url: photo.user.links.html
      },
      source: {
        provider: this.name,
        url: photo.links.html
      },
      license: 'free',
      tags: photo.tags?.map((t: any) => t.title) || [],
      downloads: {
        small: photo.urls.small,
        medium: photo.urls.regular,
        large: photo.urls.full,
        original: photo.urls.raw
      }
    }));

    return {
      query,
      total: data.total,
      page,
      perPage,
      results,
      nextPage: page * perPage < data.total ? page + 1 : undefined,
      provider: this.name
    };
  }

  async isAvailable(): Promise<boolean> {
    return !!this.config.apiKey;
  }
}
