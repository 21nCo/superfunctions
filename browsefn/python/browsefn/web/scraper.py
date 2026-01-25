"""
Web scraper service
"""

import asyncio
from typing import Dict, Optional, List
from datetime import datetime
from browsefn.core.types import (
    WebConfig,
    GetPageOptions,
    PageResult,
    WebProvider,
    MetadataOptions,
    MetadataResult,
    PageMetadata
)
from browsefn.core.provider_manager import ProviderManager
from browsefn.utils.html_utils import extract_metadata


class WebScraper:
    """Web scraping service with provider management"""
    
    def __init__(self, config: Optional[WebConfig] = None):
        self.config = config or WebConfig()
        self.providers: Dict[str, WebProvider] = {}
        self.provider_manager = ProviderManager(
            self.providers,
            self.config.default_provider,
            self.config.fallback_chain
        )

    def register_provider(self, name: str, provider: WebProvider):
        """Register a web scraping provider"""
        self.provider_manager.register_provider(name, provider)

    async def get_page(self, url: str, options: Optional[GetPageOptions] = None) -> PageResult:
        """Fetch a single web page"""
        options = options or GetPageOptions()
        provider = self.provider_manager.get_provider(options.provider)
        return await provider.get_page(url, options)

    async def get_multiple_metadata(
        self,
        urls: List[str],
        options: Optional[MetadataOptions] = None
    ) -> List[MetadataResult]:
        """Fetch metadata for multiple URLs concurrently"""
        options = options or MetadataOptions()
        concurrency = options.concurrency or 5
        
        # Create semaphore for concurrency control
        semaphore = asyncio.Semaphore(concurrency)
        completed = 0
        total = len(urls)
        
        async def fetch_metadata(url: str) -> MetadataResult:
            """Fetch metadata for a single URL"""
            nonlocal completed
            
            async with semaphore:
                start_time = datetime.now()
                
                try:
                    # Fetch page with minimal options
                    page_options = GetPageOptions(
                        format='html',
                        timeout=options.timeout or 10000,
                        cache=options.cache
                    )
                    
                    provider = self.provider_manager.get_provider()
                    page_result = await provider.get_page(url, page_options)
                    
                    # Filter metadata fields if specified
                    metadata_dict = page_result.metadata.dict()
                    if options.fields:
                        metadata_dict = {
                            k: v for k, v in metadata_dict.items()
                            if k in options.fields or k == 'url'
                        }
                    
                    metadata = PageMetadata(**metadata_dict)
                    duration = (datetime.now() - start_time).total_seconds() * 1000
                    
                    result = MetadataResult(
                        success=True,
                        data=metadata,
                        cached=page_result.cached,
                        duration=duration,
                        provider=page_result.provider
                    )
                    
                except Exception as error:
                    duration = (datetime.now() - start_time).total_seconds() * 1000
                    result = MetadataResult(
                        success=False,
                        error=str(error),
                        duration=duration
                    )
                
                # Update progress
                completed += 1
                # Note: onProgress callback omitted since it's a function type
                
                return result
        
        # Fetch all URLs concurrently
        tasks = [fetch_metadata(url) for url in urls]
        results = await asyncio.gather(*tasks)
        
        return results

