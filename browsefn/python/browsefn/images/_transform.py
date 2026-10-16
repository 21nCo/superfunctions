"""Bounded static image processing; output is published only after successful encoding."""
from __future__ import annotations

import asyncio
from io import BytesIO
from pathlib import Path
from urllib.parse import urlparse

from PIL import Image, ImageDraw, ImageFont, ImageOps

from browsefn.core.errors import BrowseFnError
from browsefn.core.types import ImageDownloadOptions, ImageMetadata
from browsefn.images._download_utils import fetch_image_bytes

PIXEL_LIMIT = 40_000_000
SIZE_BOUNDS = {"small": 640, "medium": 1280, "large": 2048}


def _open(content: bytes) -> Image.Image:
    image = Image.open(BytesIO(content))
    if image.format not in {"JPEG", "PNG", "WEBP"} or getattr(image, "n_frames", 1) != 1:
        raise ValueError("Only static JPEG, PNG and WebP images are supported.")
    if image.width * image.height > PIXEL_LIMIT:
        raise ValueError("Image exceeds the 40 million pixel limit.")
    image.load()
    return image


async def transform_image(content: bytes, options: ImageDownloadOptions) -> tuple[bytes, ImageMetadata]:
    try:
        watermark_bytes = None
        if options.watermark and options.watermark.image:
            source = options.watermark.image
            scheme = urlparse(source).scheme
            if scheme in {"http", "https"}:
                watermark_bytes = await fetch_image_bytes(source, options)
            elif scheme:
                raise BrowseFnError("INVALID_ARGUMENT", "Watermark image must be a local file path or HTTP(S) URL.")
            else:
                def read():
                    with Path(source).open("rb") as handle:
                        data = handle.read(options.max_payload_bytes + 1)
                    if len(data) > options.max_payload_bytes:
                        raise BrowseFnError("DOWNLOAD_TOO_LARGE", "Watermark image exceeds the configured maximum size.")
                    return data
                watermark_bytes = await asyncio.to_thread(read)
        return await asyncio.to_thread(_transform, content, options, watermark_bytes)
    except BrowseFnError:
        raise
    except Exception as error:
        raise BrowseFnError("INVALID_ARGUMENT", f"Image processing failed: {error}") from error


def _transform(content: bytes, options: ImageDownloadOptions, watermark_bytes: bytes | None):
    with _open(content) as source:
        original_format = source.format.lower()
        changes = any(getattr(options, name) is not None for name in ("format", "quality", "max_width", "max_height", "crop", "watermark")) or options.size in SIZE_BOUNDS
        if not changes:
            return content, ImageMetadata(format=original_format, width=source.width, height=source.height, size=len(content), hasAlpha="A" in source.getbands() or "transparency" in source.info)
        image = ImageOps.exif_transpose(source).convert("RGBA")
    if options.crop:
        crop = options.crop
        if crop.x + crop.width > image.width or crop.y + crop.height > image.height:
            raise ValueError("Crop rectangle exceeds image dimensions.")
        image = image.crop((crop.x, crop.y, crop.x + crop.width, crop.y + crop.height))
    preset = SIZE_BOUNDS.get(options.size)
    if options.max_width or options.max_height or preset:
        image.thumbnail((options.max_width or preset or image.width, options.max_height or preset or image.height), Image.Resampling.LANCZOS)
    watermark = options.watermark
    if watermark:
        overlays = []
        if watermark_bytes:
            with _open(watermark_bytes) as mark:
                overlays.append(ImageOps.exif_transpose(mark).convert("RGBA"))
        if watermark.text:
            font = ImageFont.load_default(size=24)
            bounds = font.getbbox(watermark.text)
            mark = Image.new("RGBA", (max(1, bounds[2] - bounds[0]), max(1, bounds[3] - bounds[1])), (0, 0, 0, 0))
            ImageDraw.Draw(mark).text((-bounds[0], -bounds[1]), watermark.text, fill="white", font=font)
            overlays.append(mark)
        for mark in overlays:
            mark.thumbnail(image.size, Image.Resampling.LANCZOS)
            opacity = watermark.opacity if watermark.opacity is not None else 0.5
            mark.putalpha(mark.getchannel("A").point(lambda value: round(value * opacity)))
            position = watermark.position or "bottom-right"
            x = 0 if "left" in position else image.width - mark.width if "right" in position else (image.width - mark.width) // 2
            y = 0 if "top" in position else image.height - mark.height if "bottom" in position else (image.height - mark.height) // 2
            image.alpha_composite(mark, (x, y))
    format = options.format or original_format
    quality = max(1, round(options.quality if options.quality is not None else 80))
    kwargs = {}
    if format == "jpeg":
        flattened = Image.new("RGB", image.size, "white")
        flattened.paste(image, mask=image.getchannel("A"))
        image = flattened
        kwargs["quality"] = quality
    elif format == "webp":
        kwargs["quality"] = quality
    elif options.quality is not None:
        # PNG quality controls palette fidelity, while keeping alpha.
        image = image.quantize(colors=max(2, round(2 + quality * 254 / 100)), method=Image.Quantize.FASTOCTREE)
    output = BytesIO()
    image.save(output, format=format.upper(), **kwargs)
    data = output.getvalue()
    if len(data) > options.max_payload_bytes:
        raise BrowseFnError("DOWNLOAD_TOO_LARGE", "Transformed image exceeds the configured maximum size.")
    return data, ImageMetadata(format=format, width=image.width, height=image.height, size=len(data), hasAlpha=format != "jpeg")
