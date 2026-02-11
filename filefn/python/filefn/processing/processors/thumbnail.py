import io
from typing import Any, List, Optional
from PIL import Image
from ..types import Processor, ProcessorInput, ProcessorResult, ProcessorOutputArtifact, ThumbnailConfig, ThumbnailSize

DEFAULT_SIZES = [
    ThumbnailSize(name='small', width=150, height=150),
    ThumbnailSize(name='medium', width=300, height=300),
    ThumbnailSize(name='large', width=600, height=600),
]

SUPPORTED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/tiff']

class ThumbnailProcessor:
    def __init__(self, config: Optional[ThumbnailConfig] = None):
        config = config or ThumbnailConfig()
        self.sizes = config.sizes or DEFAULT_SIZES
        self.quality = config.quality or 80
        self.format = config.format or 'jpeg'
        self.name = 'thumbnail'
        self.supportedMimeTypes = SUPPORTED_MIME_TYPES

    async def process(self, input: ProcessorInput, get_data: Any) -> ProcessorResult:
        if input.mimeType not in self.supportedMimeTypes:
             return ProcessorResult(success=False, artifacts=[], error=f"Unsupported MIME type: {input.mimeType}")

        try:
            image_data = await get_data()
            artifacts = []

            for size in self.sizes:
                thumbnail_data = self._generate_thumbnail(image_data, size)
                
                output_mime_type = 'image/jpeg'
                extension = 'jpg'
                if self.format == 'png':
                    output_mime_type = 'image/png'
                    extension = 'png'
                elif self.format == 'webp':
                    output_mime_type = 'image/webp'
                    extension = 'webp'
                
                base_key = input.storageKey.rsplit('.', 1)[0]
                storage_key = f"{base_key}-thumb-{size.name}.{extension}"

                artifacts.append(ProcessorOutputArtifact(
                    kind=f"thumbnail-{size.name}",
                    data=thumbnail_data,
                    mimeType=output_mime_type,
                    storageKey=storage_key,
                    metadata={
                        'width': size.width,
                        'height': size.height,
                        'quality': self.quality,
                        'format': self.format,
                        'sourceFileId': input.fileId,
                        'sourceVersionId': input.versionId,
                        'originalSize': len(image_data),
                        'thumbnailSize': len(thumbnail_data)
                    }
                ))

            return ProcessorResult(success=True, artifacts=artifacts)

        except Exception as e:
            return ProcessorResult(success=False, artifacts=[], error=str(e))

    def _generate_thumbnail(self, image_data: bytes, size: ThumbnailSize) -> bytes:
        with io.BytesIO(image_data) as f:
            with Image.open(f) as img:
                img = img.copy() # Avoid issues with open files
                
                # Convert to RGB if needed (e.g. RGBA to JPEG)
                if self.format == 'jpeg' and img.mode in ('RGBA', 'P'):
                    img = img.convert('RGB')
                
                img.thumbnail((size.width, size.height), Image.Resampling.LANCZOS)
                
                out_buffer = io.BytesIO()
                fmt = self.format.upper()
                if fmt == 'JPG': fmt = 'JPEG'
                
                save_args = {'format': fmt, 'quality': self.quality}
                if fmt == 'PNG':
                     save_args['optimize'] = True
                     del save_args['quality'] # PNG uses compress_level but simple save is fine

                img.save(out_buffer, **save_args)
                return out_buffer.getvalue()

def create_thumbnail_processor(config: Optional[ThumbnailConfig] = None) -> Processor:
    return ThumbnailProcessor(config)

THUMBNAIL_SUPPORTED_MIME_TYPES = SUPPORTED_MIME_TYPES
