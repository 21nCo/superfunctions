from __future__ import annotations

from pathlib import Path
from urllib.parse import urlparse

from browsefn.core.errors import BrowseFnError
from browsefn.core.types import ImageDownloadOptions


def resolve_download_path(url: str, options: ImageDownloadOptions, *, default_name: str = "downloaded-image") -> Path:
    destination_root = Path(options.destination or ".").resolve()
    destination_root.mkdir(parents=True, exist_ok=True)

    requested_name = options.filename or Path(urlparse(url).path).name or default_name
    path = (destination_root / requested_name).resolve()

    try:
        path.relative_to(destination_root)
    except ValueError as error:
        raise BrowseFnError(
            "SECURITY_POLICY_BLOCKED",
            "Destination filename must stay within the destination directory.",
        ) from error

    path.parent.mkdir(parents=True, exist_ok=True)
    return path
