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


class PixabayProvider:
    """Pixabay API image provider"""

    name = "pixabay"

    def __init__(self, config: Optional[ProviderConfig] = None):
        self.config = config or ProviderConfig()
        self.api_key = self.config.api_key
        self.base_url = "https://pixabay.com/api/"

    async def search(self, query: str, options: ImageSearchOptions) -> ImageSearchResult:
        """Search for images on Pixabay"""
        if not self.api_key:
            raise BrowseFnError("PROVIDER_UNAVAILABLE", "Pixabay API key is required", provider=self.name)

        # Build request params
        params = {
            'key': self.api_key,
            'q': query,
            'page': options.page or 1,
            'per_page': options.per_page or 20,
            'image_type': 'photo',
            'safesearch': 'true' if options.filters and options.filters.safe_search else 'false'
        }

        if options.orientation:
            params['orientation'] = options.orientation

        if options.color:
            params['colors'] = options.color

        if options.order_by:
            order_map = {'popular': 'popular', 'latest': 'latest'}
            params['order'] = order_map.get(options.order_by, 'popular')

        # Make API request
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(self.base_url, params=params)
            response.raise_for_status()
            data = response.json()

        results = []
        for item in data.get('hits', []):
            if not passes_dimension_filters(
                options.filters,
                width=item.get('imageWidth', 0),
                height=item.get('imageHeight', 0),
            ):
                continue

            tags = item.get('tags', '').split(', ') if item.get('tags') else []

            result = ImageResult(
                id=str(item.get('id')),
                url=item.get('largeImageURL', ''),
                thumbnail=item.get('previewURL', ''),
                width=item.get('imageWidth', 0),
                height=item.get('imageHeight', 0),
                description=tags[0] if tags else None,
                alt=', '.join(tags),
                author=ImageAuthor(
                    name=item.get('user', ''),
                    url=f"https://pixabay.com/users/{item.get('user', '')}-{item.get('user_id', '')}/"
                ),
                source=ImageSource(
                    provider=self.name,
                    url=item.get('pageURL', '')
                ),
                license='Pixabay License',
                tags=tags,
                downloads=ImageDownloads(
                    small=item.get('previewURL'),
                    medium=item.get('webformatURL'),
                    large=item.get('largeImageURL'),
                    original=item.get('imageURL')
                )
            )
            results.append(result)

        return build_search_result(
            query=query,
            total=data.get('totalHits', 0),
            page=params['page'],
            per_page=params['per_page'],
            results=results,
            provider=self.name,
        )

    async def download(self, url: str, options: ImageDownloadOptions) -> DownloadResult:
        return await download_image(url, options)

    async def is_available(self) -> bool:
        """Check if Pixabay API is available"""
        return bool(self.api_key)
