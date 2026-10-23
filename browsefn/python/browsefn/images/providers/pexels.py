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


class PexelsProvider:
    """Pexels API image provider"""
    
    name = "pexels"
    
    def __init__(self, config: Optional[ProviderConfig] = None):
        self.config = config or ProviderConfig()
        self.api_key = self.config.api_key
        self.base_url = "https://api.pexels.com/v1"
    
    async def search(self, query: str, options: ImageSearchOptions) -> ImageSearchResult:
        """Search for images on Pexels"""
        if not self.api_key:
            raise BrowseFnError("PROVIDER_UNAVAILABLE", "Pexels API key is required", provider=self.name)
        
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
        
        # Make API request
        headers = {'Authorization': self.api_key}
        
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f'{self.base_url}/search',
                params=params,
                headers=headers
            )
            response.raise_for_status()
            data = response.json()
        
        results = []
        for item in data.get('photos', []):
            if not passes_dimension_filters(
                options.filters,
                width=item.get('width', 0),
                height=item.get('height', 0),
            ):
                continue
            
            src = item.get('src', {})
            photographer = item.get('photographer', '')
            
            result = ImageResult(
                id=str(item.get('id')),
                url=src.get('large2x', ''),
                thumbnail=src.get('tiny', ''),
                width=item.get('width', 0),
                height=item.get('height', 0),
                description=item.get('alt'),
                alt=item.get('alt'),
                author=ImageAuthor(
                    name=photographer,
                    url=item.get('photographer_url')
                ),
                source=ImageSource(
                    provider=self.name,
                    url=item.get('url', '')
                ),
                license='Pexels License',
                tags=None,  # Pexels doesn't provide tags in API
                downloads=ImageDownloads(
                    small=src.get('small'),
                    medium=src.get('medium'),
                    large=src.get('large'),
                    original=src.get('original')
                )
            )
            results.append(result)
        
        return build_search_result(
            query=query,
            total=data.get('total_results', 0),
            page=params['page'],
            per_page=params['per_page'],
            results=results,
            provider=self.name,
        )
    
    async def download(self, url: str, options: ImageDownloadOptions) -> DownloadResult:
        return await download_image(url, options)
    
    async def is_available(self) -> bool:
        """Check if Pexels API is available"""
        return bool(self.api_key)
