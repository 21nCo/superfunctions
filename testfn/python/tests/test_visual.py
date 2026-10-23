import os
from pathlib import Path

import pytest
from PIL import Image

from testfn.visual import VisualTester


def test_visual_comparison(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    tester = VisualTester(baseline_dir="test_baselines", diff_dir="test_diffs")

    # Create dummy images
    img1 = Image.new("RGB", (100, 100), color="red")
    img1_path = "img1.png"
    img1.save(img1_path)

    img2 = Image.new("RGB", (100, 100), color="blue")
    img2_path = "img2.png"
    img2.save(img2_path)

    # First time: saves as baseline
    passed, score, diff_path = tester.compare_screenshots(img1_path, "dummy")
    assert passed is True
    assert score == 0.0
    assert os.path.exists("test_baselines/dummy.png")

    # Second time: compare with baseline (different)
    passed, score, diff_path = tester.compare_screenshots(img2_path, "dummy")
    assert passed is False
    assert score > 0.1
    assert diff_path is not None
    assert os.path.exists(diff_path)

    # Cleanup
    for p in [img1_path, img2_path, "test_baselines/dummy.png", diff_path]:
        if p and os.path.exists(p):
            os.remove(p)
    if os.path.exists("test_baselines"):
        os.rmdir("test_baselines")
    if os.path.exists("test_diffs"):
        os.rmdir("test_diffs")


def test_alpha_and_safe_paths(tmp_path: Path) -> None:
    from PIL import Image

    from testfn.visual import VisualTester

    tester = VisualTester(str(tmp_path / "base"), str(tmp_path / "diff"))
    current = tmp_path / "current.png"
    Image.new("RGBA", (2, 2), (255, 0, 0, 0)).save(current)
    assert tester.compare_screenshots(str(current), "alpha")[0]
    Image.new("RGBA", (2, 2), (255, 0, 0, 255)).save(current)
    passed, score, diff = tester.compare_screenshots(str(current), "alpha", threshold=0)
    assert not passed and score > 0 and diff
    with pytest.raises(ValueError):
        tester.compare_screenshots(str(current), "../escape")
    with pytest.raises(ValueError):
        tester.compare_screenshots(str(current), "alpha", threshold=float("nan"))
