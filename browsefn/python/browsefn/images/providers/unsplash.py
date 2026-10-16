import httpx
from typing import Optional
from browsefn.core.errors import BrowseFnError
from browsefn.core.types import (
    ImageSearchOptions,
    ImageSearchResult,
    ImageResult,
    ImageAuthor,
    ImageSource,
    ImageDownloads,
    ImageDownloadOptions,
    DownloadResult,
    ProviderConfig
)
from ._shared import build_search_result, download_image, passes_dimension_filters


class UnsplashProvider:
    """Unsplash API image provider"""

    name = "unsplash"

    def __init__(self, config: Optional[ProviderConfig] = None):
        self.config = config or ProviderConfig()
        self.api_key = self.config.api_key
        self.base_url = "https://api.unsplash.com"

    async def search(self, query: str, options: ImageSearchOptions) -> ImageSearchResult:
        """Search for images on Unsplash"""
        if not self.api_key:
            raise BrowseFnError("PROVIDER_UNAVAILABLE", "Unsplash API key is required", provider=self.name)

        # Build request params
        params = {
            'query': query,
            'page': options.page or 1,
            'per_page': options.per_page or 20,
        }

        if options.orientation:
            params['orientation'] = options.orientation

        if options.color:
            params['color'] = options.color

        if options.order_by:
            order_map = {'relevant': 'relevant', 'latest': 'latest', 'popular': 'popular'}
            params['order_by'] = order_map.get(options.order_by, 'relevant')

        # Make API request
        headers = {'Authorization': f'Client-ID {self.api_key}'}

        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f'{self.base_url}/search/photos',
                params=params,
                headers=headers
            )
            response.raise_for_status()
            data = response.json()

        results = []
        for item in data.get('results', []):
            if not passes_dimension_filters(
                options.filters,
                width=item.get('width', 0),
                height=item.get('height', 0),
            ):
                continue

            user = item.get('user', {})
            urls = item.get('urls', {})

            result = ImageResult(
                id=item.get('id'),
                url=urls.get('regular', ''),
                thumbnail=urls.get('thumb', ''),
                width=item.get('width', 0),
                height=item.get('height', 0),
                description=item.get('description') or item.get('alt_description'),
                alt=item.get('alt_description'),
                author=ImageAuthor(
                    name=user.get('name', ''),
                    url=user.get('links', {}).get('html')
                ),
                source=ImageSource(
                    provider=self.name,
                    url=item.get('links', {}).get('html', '')
                ),
                license='Unsplash License',
                tags=[tag.get('title') for tag in item.get('tags', [])],
                downloads=ImageDownloads(
                    small=urls.get('small'),
                    medium=urls.get('regular'),
                    large=urls.get('full'),
                    original=urls.get('raw')
                )
            )
            results.append(result)

        return build_search_result(
            query=query,
            total=data.get('total', 0),
            page=params['page'],
            per_page=params['per_page'],
            results=results,
            provider=self.name,
        )

    async def download(self, url: str, options: ImageDownloadOptions) -> DownloadResult:
        return await download_image(url, options)

    async def is_available(self) -> bool:
        """Check if Unsplash API is available"""
        return bool(self.api_key)
