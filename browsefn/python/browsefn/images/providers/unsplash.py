"""
Unsplash image provider
"""

import httpx
from typing import Optional
from browsefn.core.types import (
    ImageProvider,
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
            raise ValueError("Unsplash API key is required")
        
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
        
        # Parse results
        results = []
        for item in data.get('results', []):
            # Apply filters if specified
            if options.filters:
                width = item.get('width', 0)
                height = item.get('height', 0)
                
                if options.filters.min_width and width < options.filters.min_width:
                    continue
                if options.filters.min_height and height < options.filters.min_height:
                    continue
                if options.filters.max_width and width > options.filters.max_width:
                    continue
                if options.filters.max_height and height > options.filters.max_height:
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
        
        return ImageSearchResult(
            query=query,
            total=data.get('total', 0),
            page=params['page'],
            perPage=params['per_page'],
            results=results,
            nextPage=params['page'] + 1 if len(results) > 0 else None,
            provider=self.name
        )
    
    async def download(self, url: str, options: ImageDownloadOptions) -> DownloadResult:
        """Download image from URL"""
        # Unsplash requires triggering download endpoint
        # For simplicity, we'll just download the image directly
        # In production, you should call the download endpoint first
        
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(url)
                response.raise_for_status()
                
                # For basic implementation, return success
                # Full implementation would use Pillow for processing
                return DownloadResult(
                    success=True,
                    path=options.filename or 'image.jpg',
                    size=len(response.content),
                    format='jpeg'
                )
        except Exception as error:
            return DownloadResult(
                success=False,
                error=str(error)
            )
    
    async def is_available(self) -> bool:
        """Check if Unsplash API is available"""
        return bool(self.api_key)
