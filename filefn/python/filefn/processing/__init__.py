from typing import Any, Callable, List, Optional

from .types import (
    CompressionConfig,
    CropOptions,
    ImageTransformConfig,
    ImageTransformOperation,
    OCRConfig,
    Processor,
    ProcessorInput,
    ProcessorOutputArtifact,
    ProcessorResult,
    ResizeOptions,
    RotateOptions,
    ThumbnailConfig,
    ThumbnailSize,
)

THUMBNAIL_SUPPORTED_MIME_TYPES = [
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif",
    "image/tiff",
]
COMPRESSION_SUPPORTED_MIME_TYPES = ["*/*"]
OCR_SUPPORTED_MIME_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/tiff"]
IMAGE_TRANSFORM_SUPPORTED_MIME_TYPES = THUMBNAIL_SUPPORTED_MIME_TYPES
VIDEO_SUPPORTED_MIME_TYPES = ["video/*"]
AUDIO_SUPPORTED_MIME_TYPES = ["audio/*"]


class _GenericProcessor:
    def __init__(
        self,
        *,
        name: str,
        kind: str,
        supported_mime_types: List[str],
        output_mime_type: str,
        output_suffix: str,
        metadata: Optional[dict[str, Any]] = None,
    ):
        self.name = name
        self.kind = kind
        self.supportedMimeTypes = supported_mime_types
        self.output_mime_type = output_mime_type
        self.output_suffix = output_suffix
        self.metadata = metadata or {}

    async def process(self, input: ProcessorInput, get_data: Callable[[], Any]) -> ProcessorResult:
        data = await get_data()
        return ProcessorResult(
            success=True,
            artifacts=[
                ProcessorOutputArtifact(
                    kind=self.kind,
                    data=data,
                    mimeType=self.output_mime_type,
                    storageKey=f"{input.storageKey}{self.output_suffix}",
                    metadata={**self.metadata, "sourceFileId": input.fileId, "sourceVersionId": input.versionId},
                )
            ],
        )


def create_thumbnail_processor(config: Optional[ThumbnailConfig] = None) -> Processor:
    from .processors.thumbnail import create_thumbnail_processor as _create_thumbnail_processor

    return _create_thumbnail_processor(config)


def create_compression_processor(config: Optional[CompressionConfig] = None) -> Processor:
    from .processors.compression import create_compression_processor as _create_compression_processor

    return _create_compression_processor(config)


def create_ocr_processor(config: Optional[OCRConfig] = None) -> Processor:
    cfg = config or OCRConfig()
    return _GenericProcessor(
        name="ocr",
        kind="ocr-text",
        supported_mime_types=OCR_SUPPORTED_MIME_TYPES,
        output_mime_type="text/plain",
        output_suffix=".ocr.txt",
        metadata={"language": cfg.language, "outputFormat": cfg.outputFormat},
    )


def create_image_transform_processor(config: ImageTransformConfig) -> Processor:
    return _GenericProcessor(
        name="image-transform",
        kind="image-transform",
        supported_mime_types=IMAGE_TRANSFORM_SUPPORTED_MIME_TYPES,
        output_mime_type="application/octet-stream",
        output_suffix=".transformed",
        metadata={"operations": [op.operation for op in config.operations]},
    )


def create_video_processor(config: Optional[dict[str, Any]] = None) -> Processor:
    cfg = config or {}
    return _GenericProcessor(
        name="video",
        kind="video",
        supported_mime_types=VIDEO_SUPPORTED_MIME_TYPES,
        output_mime_type=cfg.get("mimeType", "video/mp4"),
        output_suffix=cfg.get("suffix", ".video"),
    )


def create_audio_processor(config: Optional[dict[str, Any]] = None) -> Processor:
    cfg = config or {}
    return _GenericProcessor(
        name="audio",
        kind="audio",
        supported_mime_types=AUDIO_SUPPORTED_MIME_TYPES,
        output_mime_type=cfg.get("mimeType", "audio/mpeg"),
        output_suffix=cfg.get("suffix", ".audio"),
    )


__all__ = [
    "Processor",
    "ProcessorInput",
    "ProcessorOutputArtifact",
    "ProcessorResult",
    "ThumbnailConfig",
    "ThumbnailSize",
    "CompressionConfig",
    "OCRConfig",
    "ImageTransformOperation",
    "ImageTransformConfig",
    "ResizeOptions",
    "CropOptions",
    "RotateOptions",
    "create_thumbnail_processor",
    "create_compression_processor",
    "create_ocr_processor",
    "create_image_transform_processor",
    "create_video_processor",
    "create_audio_processor",
    "THUMBNAIL_SUPPORTED_MIME_TYPES",
    "COMPRESSION_SUPPORTED_MIME_TYPES",
    "OCR_SUPPORTED_MIME_TYPES",
    "IMAGE_TRANSFORM_SUPPORTED_MIME_TYPES",
    "VIDEO_SUPPORTED_MIME_TYPES",
    "AUDIO_SUPPORTED_MIME_TYPES",
]
