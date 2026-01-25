"""
Pixabay image provider
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
            raise ValueError("Pixabay API key is required")
        
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
        
        # Parse results
        results = []
        for item in data.get('hits', []):
            # Apply filters if specified
            if options.filters:
                width = item.get('imageWidth', 0)
                height = item.get('imageHeight', 0)
                
                if options.filters.min_width and width < options.filters.min_width:
                    continue
                if options.filters.min_height and height < options.filters.min_height:
                    continue
                if options.filters.max_width and width > options.filters.max_width:
                    continue
                if options.filters.max_height and height > options.filters.max_height:
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
        
        return ImageSearchResult(
            query=query,
            total=data.get('totalHits', 0),
            page=params['page'],
            perPage=params['per_page'],
            results=results,
            nextPage=params['page'] + 1 if len(results) > 0 else None,
            provider=self.name
        )
    
    async def download(self, url: str, options: ImageDownloadOptions) -> DownloadResult:
        """Download image from URL"""
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(url)
                response.raise_for_status()
                
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
        """Check if Pixabay API is available"""
        return bool(self.api_key)
