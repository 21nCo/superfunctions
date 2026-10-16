/**
 * Pexels provider for image search
 */

import type {
  ImageProvider,
  ImageSearchOptions,
  ImageSearchResult,
  ImageResult
} from '../../core/types.js';

export class PexelsProvider implements ImageProvider {
  name = 'pexels';

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
    const endpoint = this.config.endpoint || 'https://api.pexels.com/v1';
    const page = options.page || 1;
    const perPage = options.perPage || 20;

    const params = new URLSearchParams({
      query,
      page: page.toString(),
      per_page: perPage.toString(),
      ...(options.orientation && { orientation: options.orientation })
    });

    const response = await fetch(`${endpoint}/search?${params}`, {
      headers: {
        'Authorization': this.config.apiKey
      }
    });

    if (!response.ok) {
      throw new Error(`Pexels API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    const results: ImageResult[] = data.photos.map((photo: any) => ({
      id: photo.id.toString(),
      url: photo.src.large,
      thumbnail: photo.src.tiny,
      width: photo.width,
      height: photo.height,
      description: photo.alt,
      alt: photo.alt,
      author: {
        name: photo.photographer,
        url: photo.photographer_url
      },
      source: {
        provider: this.name,
        url: photo.url
      },
      license: 'free',
      downloads: {
        small: photo.src.small,
        medium: photo.src.medium,
        large: photo.src.large,
        original: photo.src.original
      }
    }));

    return {
      query,
      total: data.total_results,
      page,
      perPage,
      results,
      nextPage: data.next_page ? page + 1 : undefined,
      provider: this.name
    };
  }

  async isAvailable(): Promise<boolean> {
    return !!this.config.apiKey;
  }
}
