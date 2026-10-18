import math
import os
import re
import tempfile
from pathlib import Path
from typing import Optional, Tuple

from PIL import Image, ImageChops, ImageStat


class VisualTester:
    def __init__(self, baseline_dir: str = "baselines", diff_dir: str = "diffs"):
        self.baseline_dir = baseline_dir
        self.diff_dir = diff_dir
        Path(baseline_dir).mkdir(parents=True, exist_ok=True)
        Path(diff_dir).mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _destination(directory: str, filename: str) -> Path:
        root = Path(directory).resolve()
        destination = root / filename
        if destination.is_symlink():
            raise ValueError("Screenshot destinations must not be symlinks")
        return destination

    @staticmethod
    def _save(image: Image.Image, path: Path, *, replace: bool = True) -> bool:
        fd, temporary = tempfile.mkstemp(prefix=".testfn-", dir=path.parent)
        os.close(fd)
        try:
            image.save(temporary, format="PNG")
            if replace:
                os.replace(temporary, path)
            else:
                try:
                    os.link(temporary, path)
                except FileExistsError:
                    return False
            return True
        finally:
            Path(temporary).unlink(missing_ok=True)

    def compare_screenshots(
        self, current_path: str, name: str, threshold: float = 0.1
    ) -> Tuple[bool, float, Optional[str]]:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name):
            raise ValueError("Screenshot names must be simple filename stems")
        if not math.isfinite(threshold) or not 0 <= threshold <= 1:
            raise ValueError("threshold must be between 0 and 1")
        baseline_path = self._destination(self.baseline_dir, f"{name}.png")
        with Image.open(current_path) as source:
            current = source.convert("RGBA")
        try:
            if not baseline_path.exists():
                if self._save(current, baseline_path, replace=False):
                    return True, 0.0, None
            with Image.open(baseline_path) as source:
                baseline = source.convert("RGBA")
            try:
                if baseline.size != current.size:
                    return False, 1.0, None
                with ImageChops.difference(baseline, current) as diff:
                    channels = ImageStat.Stat(diff).mean
                    score = max(sum(channels[:3]) / (3 * 255), channels[3] / 255)
                    passed = score <= threshold
                    path = None
                    if not passed:
                        destination = self._destination(
                            self.diff_dir, f"{name}_diff.png"
                        )
                        with diff.convert("RGB") as rgb, diff.getchannel("A") as alpha:
                            with alpha.convert("RGB") as alpha_rgb:
                                with ImageChops.lighter(rgb, alpha_rgb) as visible:
                                    self._save(visible, destination)
                        path = str(destination)
                    return passed, score, path
            finally:
                baseline.close()
        finally:
            current.close()
