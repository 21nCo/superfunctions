from __future__ import annotations

from collections import OrderedDict
from browsefn.core.errors import BrowseFnError
from browsefn.core.types import ImageDownloadOptions, ImageResult


class ImageSelection:
    def __init__(self):
        self.results: OrderedDict[str, ImageResult] = OrderedDict()

    def remember(self, images: list[ImageResult]) -> None:
        for image in images:
            urls = [image.url, image.source.url]
            if image.downloads:
                urls.extend(image.downloads.model_dump().values())
            for url in urls:
                if url:
                    self.results.pop(url, None)
                    self.results[url] = image
                    while len(self.results) > 1000:
                        self.results.popitem(last=False)

    def resolve(self, source: str | ImageResult, options: ImageDownloadOptions):
        image = self.results.get(source) if isinstance(source, str) else source
        selected = getattr(image.downloads, options.size, None) if options.size and image and image.downloads else None
        if image and options.size and not selected:
            raise BrowseFnError("INVALID_ARGUMENT", f"Provider result has no {options.size} download URL.")
        if selected:
            return selected, options.model_copy(update={"size": None})
        return source if isinstance(source, str) else source.url, options
