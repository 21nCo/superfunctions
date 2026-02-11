from .types import (
    Processor,
    ProcessorInput,
    ProcessorOutputArtifact,
    ProcessorResult,
    ThumbnailConfig,
    ThumbnailSize,
    CompressionConfig,
    OCRConfig,
    ImageTransformOperation,
    ImageTransformConfig,
    ResizeOptions,
    CropOptions,
    RotateOptions
)

from .processors.thumbnail import (
    create_thumbnail_processor,
    THUMBNAIL_SUPPORTED_MIME_TYPES
)

from .processors.compression import (
    create_compression_processor,
    COMPRESSION_SUPPORTED_MIME_TYPES
)
