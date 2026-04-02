import io
from pathlib import PurePosixPath
from typing import Any, Optional

from ..types import (
    CropOptions,
    ImageTransformConfig,
    Processor,
    ProcessorInput,
    ProcessorOutputArtifact,
    ProcessorResult,
    ResizeOptions,
    RotateOptions,
)

SUPPORTED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/tiff"]
UNSUPPORTED_MIME_TYPE_ERROR = "FILEFN_PROCESSING_UNSUPPORTED_MIME_TYPE"
IMAGE_TRANSFORM_FAILED_ERROR = "FILEFN_PROCESSING_IMAGE_TRANSFORM_FAILED"


class ImageTransformProcessor:
    def __init__(self, config: ImageTransformConfig):
        self.config = config
        self.name = "image-transform"
        self.supportedMimeTypes = SUPPORTED_MIME_TYPES

    async def process(self, input: ProcessorInput, get_data: Any) -> ProcessorResult:
        if input.mimeType not in self.supportedMimeTypes:
            return ProcessorResult(success=False, artifacts=[], error=UNSUPPORTED_MIME_TYPE_ERROR)

        try:
            from PIL import Image

            source_data = await get_data()
            with Image.open(io.BytesIO(source_data)) as img:
                working = img.copy()
                applied = []

                for operation in self.config.operations:
                    suffix = operation.suffix or operation.operation
                    applied.append(suffix)
                    if operation.operation == "resize" and isinstance(operation.options, ResizeOptions):
                        width = operation.options.width or working.width
                        height = operation.options.height or working.height
                        target_size = self._resolve_resize_target(
                            working.width,
                            working.height,
                            width,
                            height,
                            operation.options.withoutEnlargement or False,
                        )
                        fit = (operation.options.fit or "cover").lower()
                        if fit == "fill":
                            working = working.resize(target_size, Image.Resampling.LANCZOS)
                        elif fit in {"contain", "inside"}:
                            from PIL import ImageOps

                            working.thumbnail(target_size, Image.Resampling.LANCZOS)
                            if fit == "contain":
                                working = ImageOps.pad(
                                    working,
                                    target_size,
                                    method=Image.Resampling.LANCZOS,
                                )
                        elif fit == "outside":
                            from PIL import ImageOps

                            working = ImageOps.fit(
                                working,
                                target_size,
                                method=Image.Resampling.LANCZOS,
                                bleed=0.0,
                                centering=(0.5, 0.5),
                            )
                        else:
                            from PIL import ImageOps

                            working = ImageOps.fit(
                                working,
                                target_size,
                                method=Image.Resampling.LANCZOS,
                                bleed=0.0,
                                centering=(0.5, 0.5),
                            )
                    elif operation.operation == "crop" and isinstance(operation.options, CropOptions):
                        box = (
                            operation.options.left,
                            operation.options.top,
                            operation.options.left + operation.options.width,
                            operation.options.top + operation.options.height,
                        )
                        working = working.crop(box)
                    elif operation.operation == "rotate" and isinstance(operation.options, RotateOptions):
                        background = operation.options.background
                        fillcolor = None
                        if background is not None:
                            fillcolor = (
                                background.get("r", 0),
                                background.get("g", 0),
                                background.get("b", 0),
                                background.get("alpha", 255),
                            )
                        working = working.rotate(operation.options.angle, expand=True, fillcolor=fillcolor)

                output_format = (self.config.outputFormat or working.format or "PNG").upper()
                if output_format == "JPG":
                    output_format = "JPEG"

                output_mime = {
                    "JPEG": "image/jpeg",
                    "PNG": "image/png",
                    "WEBP": "image/webp",
                    "GIF": "image/gif",
                    "TIFF": "image/tiff",
                }.get(output_format, "image/png")
                extension = {
                    "JPEG": "jpg",
                    "PNG": "png",
                    "WEBP": "webp",
                    "GIF": "gif",
                    "TIFF": "tiff",
                }.get(output_format, "png")

                if output_format == "JPEG" and working.mode not in ("RGB", "L"):
                    working = working.convert("RGB")

                out_buffer = io.BytesIO()
                save_kwargs: dict[str, Any] = {"format": output_format}
                if output_format in ("JPEG", "WEBP") and self.config.outputQuality is not None:
                    save_kwargs["quality"] = self.config.outputQuality
                working.save(out_buffer, **save_kwargs)

                base_key = self._split_storage_key(input.storageKey)
                suffix = "-".join(applied) if applied else "transformed"
                return ProcessorResult(
                    success=True,
                    artifacts=[
                        ProcessorOutputArtifact(
                            kind="image-transform",
                            data=out_buffer.getvalue(),
                            mimeType=output_mime,
                            storageKey=f"{base_key}-{suffix}.{extension}",
                            metadata={
                                "operations": [op.operation for op in self.config.operations],
                                "sourceFileId": input.fileId,
                                "sourceVersionId": input.versionId,
                            },
                        )
                    ],
                )
        except Exception:
            return ProcessorResult(success=False, artifacts=[], error=IMAGE_TRANSFORM_FAILED_ERROR)

    @staticmethod
    def _resolve_resize_target(
        current_width: int,
        current_height: int,
        requested_width: int,
        requested_height: int,
        without_enlargement: bool,
    ) -> tuple[int, int]:
        width = max(1, requested_width)
        height = max(1, requested_height)
        if without_enlargement:
            width = min(width, current_width)
            height = min(height, current_height)
        return (width, height)

    @staticmethod
    def _split_storage_key(storage_key: str) -> str:
        path = PurePosixPath(storage_key)
        stem = path.stem
        if str(path.parent) in ("", "."):
            return stem
        return str(path.parent / stem)


def create_image_transform_processor(config: ImageTransformConfig) -> Processor:
    return ImageTransformProcessor(config)


IMAGE_TRANSFORM_SUPPORTED_MIME_TYPES = SUPPORTED_MIME_TYPES
