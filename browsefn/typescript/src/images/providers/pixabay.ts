/**
 * Pixabay provider for image search
 */

import type {
  ImageProvider,
  ImageSearchOptions,
  ImageSearchResult,
  ImageResult
} from '../../core/types.js';

export class PixabayProvider implements ImageProvider {
  name = 'pixabay';

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
    const endpoint = this.config.endpoint || 'https://pixabay.com/api';
    const page = options.page || 1;
    const perPage = options.perPage || 20;

    const params = new URLSearchParams({
      key: this.config.apiKey,
      q: query,
      page: page.toString(),
      per_page: perPage.toString(),
      ...(options.orientation && { orientation: options.orientation }),
      ...(options.filters?.safeSearch && { safesearch: 'true' }),
      ...(options.orderBy && { order: options.orderBy })
    });

    const response = await fetch(`${endpoint}/?${params}`);

    if (!response.ok) {
      throw new Error(`Pixabay API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    const results: ImageResult[] = data.hits.map((hit: any) => ({
      id: hit.id.toString(),
      url: hit.largeImageURL,
      thumbnail: hit.previewURL,
      width: hit.imageWidth,
      height: hit.imageHeight,
      description: hit.tags,
      alt: hit.tags,
      author: {
        name: hit.user,
        url: `https://pixabay.com/users/${hit.user}-${hit.user_id}/`
      },
      source: {
        provider: this.name,
        url: hit.pageURL
      },
      license: 'free',
      tags: hit.tags.split(', '),
      downloads: {
        small: hit.webformatURL,
        medium: hit.largeImageURL,
        large: hit.largeImageURL,
        original: hit.largeImageURL
      }
    }));

    return {
      query,
      total: data.totalHits,
      page,
      perPage,
      results,
      nextPage: page * perPage < data.totalHits ? page + 1 : undefined,
      provider: this.name
    };
  }

  async isAvailable(): Promise<boolean> {
    return !!this.config.apiKey;
  }
}
