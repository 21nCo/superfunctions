import os
from typing import Optional, Tuple
from PIL import Image, ImageChops, ImageStat
from .types import Artifact

class VisualTester:
    def __init__(self, baseline_dir: str = "baselines", diff_dir: str = "diffs"):
        self.baseline_dir = baseline_dir
        self.diff_dir = diff_dir
        os.makedirs(baseline_dir, exist_ok=True)
        os.makedirs(diff_dir, exist_ok=True)

    def compare_screenshots(
        self, current_path: str, name: str, threshold: float = 0.1
    ) -> Tuple[bool, float, Optional[str]]:
        baseline_path = os.path.join(self.baseline_dir, f"{name}.png")
        
        if not os.path.exists(baseline_path):
            # If no baseline, save current as baseline and return pass
            Image.open(current_path).save(baseline_path)
            return True, 0.0, None

        img1 = Image.open(baseline_path).convert("RGB")
        img2 = Image.open(current_path).convert("RGB")

        if img1.size != img2.size:
            # Resize img2 to img1 size for comparison if needed, 
            # but usually it's a failure if sizes differ
            return False, 1.0, None

        diff = ImageChops.difference(img1, img2)
        stat = ImageStat.Stat(diff)
        # stat.mean returns average pixel difference per channel [R, G, B]
        diff_score = sum(stat.mean) / (3 * 255) # Normalized 0-1

        passed = diff_score <= threshold
        diff_path = None

        if not passed:
            diff_path = os.path.join(self.diff_dir, f"{name}_diff.png")
            diff.save(diff_path)

        return passed, diff_score, diff_path
