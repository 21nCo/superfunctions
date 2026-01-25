from typing import Dict, Optional, List
from browsefn.core.types import ImageConfig, ImageSearchOptions, ImageSearchResult, ImageDownloadOptions, DownloadResult, ImageProvider
from browsefn.core.provider_manager import ProviderManager

class ImageBrowser:
    def __init__(self, config: Optional[ImageConfig] = None):
        self.config = config or ImageConfig()
        self.providers: Dict[str, ImageProvider] = {}
        self.provider_manager = ProviderManager(self.providers, self.config.default_provider)

    def register_provider(self, name: str, provider: ImageProvider):
        self.provider_manager.register_provider(name, provider)

    async def search(self, query: str, options: Optional[ImageSearchOptions] = None) -> ImageSearchResult:
        options = options or ImageSearchOptions(query=query)
        provider = self.provider_manager.get_provider(options.provider)
        return await provider.search(query, options)

    async def download(self, url: str, options: Optional[ImageDownloadOptions] = None) -> DownloadResult:
        options = options or ImageDownloadOptions()
        # This implies the provider needs to handle download or we need a specific provider for the URL
        # For simplicity, we use the default provider or a generic one if not specified
        provider = self.provider_manager.get_provider()
        if hasattr(provider, 'download'):
             return await provider.download(url, options)
        raise NotImplementedError("Default provider does not support download")
